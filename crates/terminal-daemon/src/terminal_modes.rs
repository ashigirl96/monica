//! Tracks the terminal modes an application turned on so `attach` can restore the ones the
//! replay tail cannot convey. Escape sequences are state *transitions*, not state: an app that
//! sends `?1049h` once at startup leaves nothing in a 256 KB tail for a reconnecting client to
//! learn the alt screen from, so the client ends up with mouse reporting on while its buffer
//! says `normal` -- a combination no real terminal can be in. tmux restores modes the same way
//! on re-attach. A connection that fell so far behind that rotation dropped part of the output
//! is brought back much the same way: moved into the right buffer ahead of what remains, and
//! told every mode once it has caught up.
//!
//! Every grouping here mirrors what xterm actually keys off, because the client's parser is the
//! yardstick: restoring a mode xterm ignores, or restoring two modes that xterm treats as one
//! slot, would leave the daemon's idea of the session out of step with what the user sees.
//!
//! That includes the kitty keyboard state, which xterm keeps per buffer: each buffer has its own
//! stack, and the flags in force are swapped with the ones saved for each buffer on every
//! buffer switch. A restore rebuilds it only for the buffer the client is in -- the app's
//! current one for `restate`, the one the tail starts in for `restore_prefix`. Reaching the other
//! buffer would mean switching to it, and `?1049h` clears the alt screen. Leaving it alone errs on
//! the cheap side: a missing push only puts keys back on the legacy encoding, which a shell still
//! reads, while an extra one keeps sending a shell CSI-u it cannot.

/// Independent flags and whether a fresh terminal has them set, in the order they are restored.
/// These are also exactly what xterm's DECSTR returns to its defaults -- the mouse protocol and
/// encoding live in a service `softReset` never touches, and neither does the alt buffer, so
/// those stay put.
const TRACKED_FLAGS: [(u16, bool); 3] = [(2004, false), (1004, false), (25, true)];

/// Handled apart from the flags because it decides *where* output lands rather than just how it
/// is reported, which means `restore_prefix` needs its value at the replay boundary, not its
/// latest value.
const ALT_SCREEN: u16 = 1049;

/// xterm switches buffers on all of these alike. Restores say `ALT_SCREEN` whichever the app
/// used, since only the buffer it lands in matters there.
const ALT_SCREEN_MODES: [u16; 3] = [47, 1047, ALT_SCREEN];

/// xterm keeps a single active mouse protocol, so these override each other and resetting any
/// one of them disables reporting outright.
const MOUSE_PROTOCOLS: [u16; 4] = [9, 1000, 1002, 1003];

/// Likewise a single active encoding. `1005`/`1015` are deliberately absent: xterm logs them as
/// unsupported without touching the slot, so tracking them would restore a no-op and lose the
/// encoding the app actually asked for.
const MOUSE_ENCODINGS: [u16; 2] = [1006, 1016];

/// Parameter bytes past this are a malformed or hostile sequence, never a mode we track.
const MAX_CSI_PARAMS: usize = 64;

const MAX_KITTY_STACK: usize = 32;

/// Alt-screen switches are the only history `restore_prefix` needs, and only to answer which
/// buffer the app was in when the tail began. `?1049h` is an assignment rather than a toggle,
/// so that answer cannot be recovered by rewinding the tail -- an app re-asserting a mode it
/// already holds is indistinguishable from one changing it. Bounded: the oldest entry folds
/// into `alt_at_history_start` when the log fills, so a boundary older than the log still
/// resolves, just at the precision of the log's start.
const MAX_ALT_HISTORY: usize = 256;

/// Mirrors the subset of xterm's VT500 transition table that CSI dispatch depends on. Notably
/// `ESC` aborts whatever is in flight from any state, which is why OSC/DCS payloads need no
/// state of their own -- their bytes can only reach a CSI through an `ESC` xterm would honour.
#[derive(Default, PartialEq)]
enum Scan {
    #[default]
    Ground,
    Esc,
    Csi,
    /// Parameters overflowed; swallow bytes until the final one.
    CsiIgnore,
}

/// One slot shared by several modes: the last one set wins, and any reset clears the slot.
#[derive(Default, Clone, Copy, PartialEq)]
enum Exclusive {
    #[default]
    Unobserved,
    Off,
    On(u16),
}

impl Exclusive {
    fn or_off(self) -> Self {
        match self {
            Self::Unobserved => Self::Off,
            observed => observed,
        }
    }
}

#[derive(Default)]
struct KittyBuffer {
    /// The flags in force before each push, oldest first.
    stack: Vec<u32>,
    /// What a switch into this buffer puts in force.
    saved_flags: u32,
    /// A stack cannot be rebuilt from a suffix, so a restore needs to know whether the replay
    /// tail pushes or pops here at all rather than just where the stack ended up.
    stack_touched: bool,
}

/// xterm's kitty keyboard state. A push saves the flags in force onto the stack of the buffer
/// the app is in, while the flags in force are a single slot that every buffer switch swaps
/// with the ones saved for each buffer.
#[derive(Default)]
struct KittyKeyboard {
    flags: u32,
    /// Normal then alt.
    buffers: [KittyBuffer; 2],
}

impl KittyKeyboard {
    fn buffer(&self, alt: bool) -> &KittyBuffer {
        &self.buffers[usize::from(alt)]
    }

    fn buffer_mut(&mut self, alt: bool) -> &mut KittyBuffer {
        &mut self.buffers[usize::from(alt)]
    }

    /// Every place flags sit outside a stack: in force, then saved for normal and for alt.
    fn flag_slots(&self) -> [u32; 3] {
        [
            self.flags,
            self.buffers[0].saved_flags,
            self.buffers[1].saved_flags,
        ]
    }

    fn push(&mut self, alt: bool, flags: u32) {
        let in_force = self.flags;
        let buffer = self.buffer_mut(alt);
        buffer.stack_touched = true;
        if buffer.stack.len() < MAX_KITTY_STACK {
            buffer.stack.push(in_force);
            self.flags = flags;
        }
    }

    fn pop(&mut self, alt: bool, count: u32) {
        let buffer = self.buffer_mut(alt);
        buffer.stack_touched = true;
        let keep = buffer.stack.len().saturating_sub(count.max(1) as usize);
        // xterm puts the last entry popped back in force, but 0 once the stack is empty,
        // whatever that entry held.
        let back_in_force = if keep == 0 { 0 } else { buffer.stack[keep] };
        buffer.stack.truncate(keep);
        self.flags = back_in_force;
    }

    /// Modes 2 and 3 (or, and-not) are taken as mode 1.
    fn set(&mut self, flags: u32) {
        self.flags = flags;
    }

    /// xterm swaps even on a switch into the buffer already in use.
    fn switch_buffer(&mut self, to_alt: bool) {
        self.buffer_mut(!to_alt).saved_flags = self.flags;
        self.flags = self.buffer(to_alt).saved_flags;
    }
}

#[derive(Default)]
pub struct TerminalModes {
    scan: Scan,
    csi: Vec<u8>,
    /// Parallel to `TRACKED_FLAGS`; `None` means never observed, so the peer's default holds.
    flags: [Option<bool>; TRACKED_FLAGS.len()],
    /// Bytes fed so far, so alt-screen switches can be placed against a replay boundary.
    stream_len: u64,
    /// `(bytes consumed through the switch, entered alt)`, oldest first.
    alt_history: std::collections::VecDeque<(u64, bool)>,
    alt_at_history_start: Option<bool>,
    mouse_protocol: Exclusive,
    mouse_encoding: Exclusive,
    kitty: KittyKeyboard,
}

impl TerminalModes {
    /// Feed a chunk of PTY output. Sequences split across chunks resume from the kept state.
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.stream_len += 1;
            self.step(b);
        }
    }

    fn record_alt_switch(&mut self, entered: bool) {
        if self.alt_history.len() == MAX_ALT_HISTORY {
            if let Some((_, dropped)) = self.alt_history.pop_front() {
                self.alt_at_history_start = Some(dropped);
            }
        }
        self.alt_history.push_back((self.stream_len, entered));
    }

    /// Which buffer the app was in once `boundary` bytes had been consumed.
    fn alt_screen_at(&self, boundary: u64) -> Option<bool> {
        let mut state = self.alt_at_history_start;
        for &(offset, entered) in &self.alt_history {
            if offset > boundary {
                break;
            }
            state = Some(entered);
        }
        state
    }

    fn in_alt_screen(&self) -> bool {
        self.alt_screen_at(self.stream_len) == Some(true)
    }

    fn step(&mut self, b: u8) {
        match self.scan {
            Scan::Ground => {
                if b == 0x1b {
                    self.scan = Scan::Esc;
                }
            }
            Scan::Esc => match b {
                0x1b => {}
                0x18 | 0x1a => self.scan = Scan::Ground,
                // C0 controls execute without ending the sequence being collected.
                0x00..=0x1f => {}
                b'[' => {
                    self.csi.clear();
                    self.scan = Scan::Csi;
                }
                // RIS returns the terminal to power-on defaults, so nothing observed before it
                // still holds -- keeping it would re-enter the alt screen on a later attach.
                // The stream offset and the alt-screen log record the stream rather than the
                // terminal, and must survive, or a boundary would be measured against the
                // wrong origin or placed in the wrong buffer.
                b'c' => {
                    *self = Self {
                        stream_len: self.stream_len,
                        alt_history: std::mem::take(&mut self.alt_history),
                        alt_at_history_start: self.alt_at_history_start,
                        ..Self::default()
                    };
                    self.record_alt_switch(false);
                }
                _ => self.scan = Scan::Ground,
            },
            Scan::Csi | Scan::CsiIgnore => match b {
                0x1b => self.scan = Scan::Esc,
                0x18 | 0x1a => {
                    self.csi.clear();
                    self.scan = Scan::Ground;
                }
                0x00..=0x1f | 0x7f => {}
                0x20..=0x3f => {
                    if self.csi.len() >= MAX_CSI_PARAMS {
                        self.scan = Scan::CsiIgnore;
                        self.csi.clear();
                    } else {
                        self.csi.push(b);
                    }
                }
                0x40..=0x7e => {
                    if self.scan == Scan::Csi {
                        self.dispatch_csi(b);
                    }
                    self.csi.clear();
                    self.scan = Scan::Ground;
                }
                _ => {}
            },
        }
    }

    fn dispatch_csi(&mut self, final_byte: u8) {
        let Some((&prefix, params)) = self.csi.split_first() else {
            return;
        };
        match (prefix, final_byte) {
            (b'?', b'h' | b'l') => {
                let on = final_byte == b'h';
                // Deferred: recording needs `&mut self` while `params` still borrows `self.csi`.
                let mut alt_switch = None;
                for param in params.split(|&b| b == b';') {
                    let Some(mode) = parse_u16(param) else {
                        continue;
                    };
                    if ALT_SCREEN_MODES.contains(&mode) {
                        self.kitty.switch_buffer(on);
                        alt_switch = Some(on);
                        continue;
                    }
                    let slot = if on {
                        Exclusive::On(mode)
                    } else {
                        Exclusive::Off
                    };
                    match classify(mode) {
                        Some(Slot::Flag(index)) => self.flags[index] = Some(on),
                        Some(Slot::MouseProtocol) => self.mouse_protocol = slot,
                        Some(Slot::MouseEncoding) => self.mouse_encoding = slot,
                        None => {}
                    }
                }
                if let Some(entered) = alt_switch {
                    self.record_alt_switch(entered);
                }
            }
            // DECSTR. Clearing to `None` rather than to a literal default keeps the defaults in
            // one place: a mode nobody asserted is a mode the fresh client already agrees on.
            // xterm's soft reset also drops the kitty keyboard state of both buffers.
            (b'!', b'p') => {
                self.flags = [None; TRACKED_FLAGS.len()];
                self.kitty = KittyKeyboard::default();
            }
            (b'>', b'u') => {
                let alt = self.in_alt_screen();
                self.kitty.push(alt, first_param(params).unwrap_or(0));
            }
            (b'<', b'u') => {
                let alt = self.in_alt_screen();
                self.kitty.pop(alt, first_param(params).unwrap_or(1));
            }
            (b'=', b'u') => self.kitty.set(first_param(params).unwrap_or(0)),
            _ => {}
        }
    }

    /// Sequences that bring a fresh terminal up to date on everything `tail` leaves unsaid.
    ///
    /// Modes the tail transitions itself only have to *end up* right, and the tail's own last
    /// transition already does that, so they are left to the tail. For everything the tail does
    /// not touch, applying this prefix then the tail lands on the tracked state -- the tail
    /// cannot hold a later transition than the tracker saw.
    ///
    /// The alt screen is the exception, because it decides *where* the tail's output lands: the
    /// client has to begin the tail in the buffer the app was in at that point, taken from the
    /// recorded history. Prepending nothing would paint a departing TUI's final frame into the
    /// shell's scrollback, and prepending the current state would drop the tail's leading
    /// normal-buffer history into the alt buffer.
    ///
    /// The kitty keyboard state is prepended for that starting buffer alone: its stack, unless
    /// the tail pushes or pops there, under the flags in force at the boundary. The other
    /// buffer's state is left out (see the module doc).
    ///
    /// `tail` must be a suffix of what has been fed, which is what `attach` hands over.
    pub fn restore_prefix(&self, tail: &[u8]) -> Vec<u8> {
        // Starting in the boundary's buffer credits each push and pop in the tail to the buffer
        // the app made it in.
        let mut in_tail = self.for_client_behind_by(tail.len() as u64);
        in_tail.feed(tail);
        let boundary = self.stream_len.saturating_sub(tail.len() as u64);
        let boundary_in_alt = self.alt_screen_at(boundary) == Some(true);

        let mut out = Vec::new();
        // The buffer switch leads so the replay body lands in the right buffer. Only the alt
        // case needs saying: a fresh client is on the normal buffer already.
        if boundary_in_alt {
            push_mode(&mut out, ALT_SCREEN, true);
        }
        for (index, &(mode, _)) in TRACKED_FLAGS.iter().enumerate() {
            let restored = if in_tail.flags[index].is_some() {
                None
            } else {
                self.flags[index]
            };
            if let Some(on) = restored {
                push_mode(&mut out, mode, on);
            }
        }
        if in_tail.mouse_protocol == Exclusive::Unobserved {
            push_exclusive(&mut out, self.mouse_protocol, MOUSE_PROTOCOLS[1]);
        }
        if in_tail.mouse_encoding == Exclusive::Unobserved {
            push_exclusive(&mut out, self.mouse_encoding, MOUSE_ENCODINGS[0]);
        }
        if !in_tail.kitty.buffer(boundary_in_alt).stack_touched {
            push_kitty_state(
                &mut out,
                &self.kitty.buffer(boundary_in_alt).stack,
                self.kitty_flags_at_start_of(tail, &in_tail),
            );
        }
        out
    }

    /// The flags in force when `tail` began, read from wherever the tail moved them, or 0 if it
    /// overwrote them everywhere. `in_tail` was fed `tail` starting with 0 in force.
    fn kitty_flags_at_start_of(&self, tail: &[u8], in_tail: &Self) -> u32 {
        // The tail only moves flags between slots or overwrites them, so feeding it again from
        // other flags in force shows which slot still holds the starting ones.
        let mut from_one = self.for_client_behind_by(tail.len() as u64);
        from_one.kitty.flags = 1;
        from_one.feed(tail);
        let from_zero = in_tail.kitty.flag_slots();
        from_one
            .kitty
            .flag_slots()
            .iter()
            .zip(from_zero)
            .position(|(&one, zero)| one != zero)
            .map_or(0, |slot| self.kitty.flag_slots()[slot])
    }

    /// A tracker for a client that consumed all but the last `unseen` bytes fed here. It starts
    /// knowing only which buffer the client is in, and keeps knowing it however many switches
    /// later fall out of this tracker's bounded history.
    pub fn for_client_behind_by(&self, unseen: u64) -> Self {
        Self {
            alt_at_history_start: self.alt_screen_at(self.stream_len.saturating_sub(unseen)),
            ..Self::default()
        }
    }

    /// Sequences that move a client which missed the output right before the last `tail_len`
    /// bytes fed here into the buffer those bytes start in. `client` was fed what the client
    /// got since `for_client_behind_by` made it. Only the buffer is settled here, because it
    /// decides where the tail lands; `restate` settles the other modes once the tail is through.
    pub fn buffer_switch_after_gap(&self, client: &Self, tail_len: u64) -> Vec<u8> {
        let mut out = Vec::new();
        // Leaving and entering again, rather than staying: xterm swaps the kitty flags on every
        // `?1049h`, even one it is already in.
        if client.in_alt_screen() {
            // xterm keeps a kitty stack per buffer and pops only the one it is in, so each is
            // emptied while the client is in it.
            push_kitty_reset(&mut out);
            push_mode(&mut out, ALT_SCREEN, false);
            push_kitty_reset(&mut out);
        }
        if self.alt_screen_at(self.stream_len.saturating_sub(tail_len)) == Some(true) {
            push_mode(&mut out, ALT_SCREEN, true);
        }
        out
    }

    /// Sequences that bring a client in the app's buffer to every mode tracked here, whatever
    /// modes it was left in. Unlike `restore_prefix`, this also states the modes a fresh client
    /// would already agree on, and empties the kitty stack of the app's buffer before rebuilding
    /// it. The other buffer's kitty state is left as the client has it (see the module doc).
    pub fn restate(&self) -> Vec<u8> {
        let mut out = Vec::new();
        push_kitty_reset(&mut out);
        for (&(mode, default_on), flag) in TRACKED_FLAGS.iter().zip(self.flags) {
            push_mode(&mut out, mode, flag.unwrap_or(default_on));
        }
        push_exclusive(&mut out, self.mouse_protocol.or_off(), MOUSE_PROTOCOLS[1]);
        push_exclusive(&mut out, self.mouse_encoding.or_off(), MOUSE_ENCODINGS[0]);
        push_kitty_state(
            &mut out,
            &self.kitty.buffer(self.in_alt_screen()).stack,
            self.kitty.flags,
        );
        out
    }
}

enum Slot {
    Flag(usize),
    MouseProtocol,
    MouseEncoding,
}

fn classify(mode: u16) -> Option<Slot> {
    if let Some(index) = TRACKED_FLAGS.iter().position(|&(m, _)| m == mode) {
        Some(Slot::Flag(index))
    } else if MOUSE_PROTOCOLS.contains(&mode) {
        Some(Slot::MouseProtocol)
    } else if MOUSE_ENCODINGS.contains(&mode) {
        Some(Slot::MouseEncoding)
    } else {
        None
    }
}

fn push_mode(out: &mut Vec<u8>, mode: u16, on: bool) {
    let final_byte = if on { 'h' } else { 'l' };
    out.extend_from_slice(format!("\x1b[?{mode}{final_byte}").as_bytes());
}

/// `off_mode` is any member of the group -- resetting one clears the shared slot.
fn push_exclusive(out: &mut Vec<u8>, state: Exclusive, off_mode: u16) {
    match state {
        Exclusive::Unobserved => {}
        Exclusive::Off => push_mode(out, off_mode, false),
        Exclusive::On(mode) => push_mode(out, mode, true),
    }
}

/// Pops more than the stack can hold, which empties it.
fn push_kitty_reset(out: &mut Vec<u8>) {
    out.extend_from_slice(format!("\x1b[<{MAX_KITTY_STACK}u").as_bytes());
}

/// Rebuilds `stack` under `flags` on a buffer whose stack is empty and flags are 0. A push saves
/// the flags in force, so only the bottom of the stack has to be set outright.
fn push_kitty_state(out: &mut Vec<u8>, stack: &[u32], flags: u32) {
    let mut levels = stack.iter().chain([&flags]);
    if let Some(bottom) = levels.next().filter(|&&bottom| bottom != 0) {
        out.extend_from_slice(format!("\x1b[={bottom}u").as_bytes());
    }
    for level in levels {
        out.extend_from_slice(format!("\x1b[>{level}u").as_bytes());
    }
}

fn parse_u16(bytes: &[u8]) -> Option<u16> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

fn first_param(params: &[u8]) -> Option<u32> {
    params.split(|&b| b == b';').next().and_then(parse_u32)
}

fn parse_u32(bytes: &[u8]) -> Option<u32> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Restores against a tail that says nothing, isolating what the tracker itself holds.
    fn restore(chunks: &[&[u8]]) -> Vec<u8> {
        const QUIET_TAIL: &[u8] = b"no sequences here";
        let mut modes = tracker(chunks);
        modes.feed(QUIET_TAIL);
        modes.restore_prefix(QUIET_TAIL)
    }

    fn tracker(chunks: &[&[u8]]) -> TerminalModes {
        let mut modes = TerminalModes::default();
        for chunk in chunks {
            modes.feed(chunk);
        }
        modes
    }

    /// `restore_prefix` is contracted on `tail` being a suffix of the stream, so tests state the
    /// stream as "what scrolled out of the window" plus "what stayed in it".
    fn restore_with_tail(before: &[u8], tail: &[u8]) -> Vec<u8> {
        let mut modes = tracker(&[before]);
        modes.feed(tail);
        modes.restore_prefix(tail)
    }

    /// The buffer switch for a client that got `seen`, then missed `gap`, ahead of `tail`.
    fn switch_after_gap(seen: &[u8], gap: &[u8], tail: &[u8]) -> Vec<u8> {
        let mut modes = tracker(&[seen]);
        let client = modes.for_client_behind_by(0);
        modes.feed(gap);
        modes.feed(tail);
        modes.buffer_switch_after_gap(&client, tail.len() as u64)
    }

    /// Claude Code's real startup handshake, transcribed from a production transcript. The
    /// leading `CSI < u` pops an empty stack and `?2031h` is untracked; both must pass through
    /// without disturbing the rest.
    #[test]
    fn claude_code_startup_handshake_is_restored_in_full() {
        let startup = b"\x1b[?2004l\x1b[?25h\x1b[?1049h\x1b[<u\x1b[>1u\
\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h";
        assert_eq!(
            restore(&[startup]),
            b"\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[>1u"
        );
    }

    /// Taken from a production transcript whose `?1049h` had scrolled out of the replay window:
    /// Claude Code re-sends the mouse modes on every resize, so only the modes it sends once at
    /// startup need carrying.
    #[test]
    fn only_modes_an_app_never_repeats_survive_into_the_prefix() {
        let startup = b"\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[>1u\
\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l";
        // What a resize puts back into the tail, and nothing else.
        let tail = b"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l\x1b[>1u";
        assert_eq!(
            restore_with_tail(startup, tail),
            b"\x1b[?1049h\x1b[?2004h\x1b[?1004h"
        );
    }

    /// A boundary older than the retained history still resolves, at the precision of the
    /// history's start rather than degrading to "unknown".
    #[test]
    fn a_boundary_older_than_the_history_falls_back_to_its_start() {
        let mut modes = TerminalModes::default();
        modes.feed(b"\x1b[?1049h");
        let early_boundary = modes.stream_len;
        for _ in 0..MAX_ALT_HISTORY {
            modes.feed(b"\x1b[?1049l\x1b[?1049h");
        }
        assert_eq!(modes.alt_history.len(), MAX_ALT_HISTORY);
        assert_eq!(modes.alt_screen_at(early_boundary), Some(true));
    }

    #[test]
    fn untouched_modes_are_not_restored() {
        assert_eq!(restore(&[b"plain output\r\n"]), b"");
    }

    #[test]
    fn alt_screen_is_restored() {
        assert_eq!(restore(&[b"\x1b[?1049h"]), b"\x1b[?1049h");
    }

    #[test]
    fn sequence_split_across_chunks_is_tracked() {
        assert_eq!(restore(&[b"before\x1b[?10", b"49h after"]), b"\x1b[?1049h");
    }

    #[test]
    fn combined_parameters_are_split() {
        assert_eq!(
            restore(&[b"\x1b[?1049;2004;25h"]),
            b"\x1b[?1049h\x1b[?2004h\x1b[?25h"
        );
    }

    #[test]
    fn reset_overrides_an_earlier_set() {
        assert_eq!(restore(&[b"\x1b[?25l\x1b[?25h\x1b[?25l"]), b"\x1b[?25l");
    }

    #[test]
    fn alt_screen_leads_the_restore_regardless_of_arrival_order() {
        let out = restore(&[b"\x1b[?2004h\x1b[?1004h\x1b[?1049h"]);
        assert_eq!(out, b"\x1b[?1049h\x1b[?2004h\x1b[?1004h");
    }

    #[test]
    fn untracked_modes_and_other_finals_are_ignored() {
        assert_eq!(restore(&[b"\x1b[?7h\x1b[?12l\x1b[2J\x1b[38;5;196m"]), b"");
    }

    // --- what the tail already says is left to the tail ---

    /// A TUI that started inside the replay window leaves its own `?1049h` in the tail, preceded
    /// by normal-buffer history that must stay in the normal buffer.
    #[test]
    fn a_tail_that_enters_the_alt_screen_starts_in_the_normal_buffer() {
        let tail = b"$ prompt\r\n\x1b[?1049h\x1b[?1006halt content";
        assert_eq!(restore_with_tail(b"earlier shell output\r\n", tail), b"");
    }

    /// The mirror image, and the one skipping the mode outright got wrong: a TUI that exited
    /// while detached leaves its last frame at the head of the tail followed by `?1049l`. Start
    /// in the normal buffer and that frame lands in the shell's scrollback for good.
    #[test]
    fn a_tail_that_leaves_the_alt_screen_starts_in_the_alt_buffer() {
        let tail = b"frame\x1b[?1049l$ prompt";
        assert_eq!(restore_with_tail(b"\x1b[?1049h", tail), b"\x1b[?1049h");
    }

    /// The case direction alone cannot answer: the app re-asserts `?1049h` while already in the
    /// alt buffer, so the tail's first switch looks like an entry even though everything before
    /// it belongs in the alt buffer too.
    #[test]
    fn a_redundant_alt_screen_set_inside_the_tail_does_not_move_the_boundary() {
        let tail = b"more frames\x1b[?1049hredrawn";
        assert_eq!(restore_with_tail(b"\x1b[?1049hframe", tail), b"\x1b[?1049h");
    }

    /// Switches after the boundary are the tail's own story and must not shift the answer.
    #[test]
    fn later_switches_in_the_tail_do_not_change_the_starting_buffer() {
        let tail = b"one\x1b[?1049ltwo\x1b[?1049hthree";
        assert_eq!(restore_with_tail(b"\x1b[?1049h", tail), b"\x1b[?1049h");
    }

    #[test]
    fn a_boundary_before_any_switch_leaves_the_buffer_at_its_default() {
        let tail = b"shell output only";
        assert_eq!(restore_with_tail(b"more shell output", tail), b"");
    }

    #[test]
    fn only_modes_missing_from_the_tail_are_prepended() {
        // The tail begins after the startup handshake and carries only the cursor change.
        assert_eq!(
            restore_with_tail(
                b"\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h",
                b"later\x1b[?25l"
            ),
            b"\x1b[?1049h\x1b[?2004h\x1b[?1003h\x1b[?1006h"
        );
    }

    #[test]
    fn a_kitty_stack_the_tail_touches_is_left_alone() {
        assert_eq!(restore_with_tail(b"\x1b[>1u", b"\x1b[>5u"), b"");
        assert_eq!(
            restore_with_tail(b"\x1b[>1u\x1b[>5u", b"nothing"),
            b"\x1b[>1u\x1b[>5u"
        );
    }

    // --- a client that missed part of the stream ---

    /// Leaving the alt screen also restores the cursor saved on entering it, so a client that
    /// never entered must not be told to leave.
    #[test]
    fn a_client_on_the_normal_buffer_is_not_taken_out_of_the_alt_screen() {
        assert_eq!(
            switch_after_gap(b"$ vim\r\n", b"\x1b[?1049h\x1b[?25l", b"frame"),
            b"\x1b[?1049h"
        );
    }

    /// xterm keeps a kitty stack per buffer, so leaving the alt screen uncovers the normal
    /// buffer's, and a push left there would outlive the app's last pop.
    #[test]
    fn a_client_taken_out_of_the_alt_screen_has_both_kitty_stacks_emptied() {
        assert_eq!(
            switch_after_gap(b"\x1b[>5u\x1b[?1049h\x1b[>1u", b"\x1b[<u\x1b[?1049l", b"$ "),
            b"\x1b[<32u\x1b[?1049l\x1b[<32u"
        );
    }

    /// A client may hold any mode, so the defaults a fresh one would assume are said too.
    #[test]
    fn restating_says_every_mode_and_rebuilds_the_kitty_stack() {
        let modes = tracker(&[b"\x1b[?2004h\x1b[?1003h\x1b[>1u\x1b[>5u"]);
        assert_eq!(
            modes.restate(),
            b"\x1b[<32u\x1b[?2004h\x1b[?1004l\x1b[?25h\x1b[?1003h\x1b[?1006l\x1b[>1u\x1b[>5u"
        );
    }

    // --- kitty keyboard, per buffer ---

    /// A TUI killed in the alt screen never pops. xterm put that push on the alt buffer's stack,
    /// so restating it on the normal buffer would send the shell CSI-u keys.
    const PUSHED_IN_ALT_THEN_LEFT: &[u8] = b"$ \x1b[?1049h\x1b[>1u frame \x1b[?1049l$ ";

    #[test]
    fn a_push_left_behind_in_the_alt_screen_is_not_restated_on_the_normal_buffer() {
        assert_eq!(
            tracker(&[PUSHED_IN_ALT_THEN_LEFT]).restate(),
            b"\x1b[<32u\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1000l\x1b[?1006l"
        );
    }

    #[test]
    fn a_push_left_behind_in_the_alt_screen_is_not_restored_on_attach() {
        assert_eq!(restore(&[PUSHED_IN_ALT_THEN_LEFT]), b"");
    }

    #[test]
    fn an_app_in_the_alt_screen_has_only_the_alt_stack_restated() {
        assert_eq!(
            tracker(&[b"\x1b[>5u\x1b[?1049h\x1b[>1u"]).restate(),
            b"\x1b[<32u\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1000l\x1b[?1006l\x1b[>1u"
        );
    }

    /// The tail leaves the alt screen, so the client has to be in it with the alt stack before
    /// the tail starts, and must not be handed the normal one there.
    #[test]
    fn a_tail_that_starts_in_the_alt_screen_gets_only_the_alt_stack() {
        assert_eq!(
            restore_with_tail(b"\x1b[>5u\x1b[?1049h\x1b[>1u", b"frame\x1b[?1049l$ "),
            b"\x1b[?1049h\x1b[>1u"
        );
    }

    /// The tail changes the kitty state in the alt screen only, so the normal stack stays as it
    /// was at the boundary, and only the prefix can carry that.
    #[test]
    fn kitty_changes_made_in_the_alt_screen_leave_the_normal_stack_to_the_prefix() {
        assert_eq!(
            restore_with_tail(b"\x1b[>5u", b"$ \x1b[?1049h\x1b[>1u frame"),
            b"\x1b[>5u"
        );
        assert_eq!(
            restore_with_tail(b"\x1b[>5u", b"$ \x1b[?1049h\x1b[=3u frame"),
            b"\x1b[>5u"
        );
    }

    /// xterm switches buffers on `?47h` and `?1047h` just as on `?1049h`, so what an app sets
    /// there stays in the alt buffer too.
    #[test]
    fn the_older_alt_screen_modes_switch_buffers_too() {
        assert_eq!(
            tracker(&[b"\x1b[?47h\x1b[=1u\x1b[?47l$ "]).restate(),
            b"\x1b[<32u\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1000l\x1b[?1006l"
        );
        assert_eq!(restore(&[b"\x1b[?1047h\x1b[>1u\x1b[?1047l$ "]), b"");
        assert_eq!(restore(&[b"\x1b[?47h\x1b[>1u"]), b"\x1b[?1049h\x1b[>1u");
    }

    #[test]
    fn a_tui_that_pops_before_leaving_the_alt_screen_hands_the_shell_its_own_stack_back() {
        assert_eq!(
            restore(&[b"\x1b[>5u\x1b[?1049h\x1b[>1u\x1b[<u\x1b[?1049l"]),
            b"\x1b[>5u"
        );
    }

    /// A push the tail makes in the alt screen is the tail's to replay. Crediting it to the
    /// normal buffer would push the alt stack a second time.
    #[test]
    fn a_tail_that_starts_in_the_alt_screen_counts_its_pushes_there() {
        assert_eq!(
            restore_with_tail(b"\x1b[>5u\x1b[?1049h", b"\x1b[>1u frame\x1b[?1049l$ "),
            b"\x1b[?1049h"
        );
    }

    /// xterm swaps the flags in force with the saved ones on every switch, even into the buffer
    /// it is already in.
    #[test]
    fn a_redundant_alt_screen_switch_swaps_the_kitty_flags_as_xterm_does() {
        let redundant_set = b"\x1b[?1049h\x1b[>1u\x1b[?1049h";
        assert_eq!(restore(&[redundant_set]), b"\x1b[?1049h\x1b[>0u");
        assert_eq!(restore(&[redundant_set, b"\x1b[?1049l"]), b"\x1b[=1u");

        let redundant_reset = b"\x1b[>1u\x1b[?1049l";
        assert_eq!(restore(&[redundant_reset]), b"\x1b[>0u");
        assert_eq!(
            restore(&[redundant_reset, b"\x1b[?1049h"]),
            b"\x1b[?1049h\x1b[=1u"
        );
    }

    /// A switch moves the flags in force into a saved slot, from where a later switch puts them
    /// back in force, so the client has to start the tail with the boundary's flags.
    #[test]
    fn the_boundary_flags_are_restored_wherever_the_tail_moves_them() {
        // Into the alt buffer's saved slot, by leaving the buffer the app is not in.
        assert_eq!(
            restore_with_tail(b"\x1b[>5u\x1b[>1u", b"$ \x1b[?1049l$ "),
            b"\x1b[>5u\x1b[>1u"
        );
        // Back into force from there, by entering the alt screen.
        assert_eq!(
            restore_with_tail(b"\x1b[>1u", b"\x1b[?1049l\x1b[?1049h"),
            b"\x1b[>1u"
        );
        // Into the normal buffer's saved slot, by entering the alt screen the app is in.
        assert_eq!(
            restore_with_tail(b"\x1b[?1049h\x1b[>1u", b"frame\x1b[?1049hredrawn"),
            b"\x1b[?1049h\x1b[>1u"
        );
    }

    /// A set leaves none of the boundary's flags to carry, but the stack under them, which a
    /// later pop brings back into force.
    #[test]
    fn a_tail_that_sets_the_kitty_flags_still_gets_the_stack() {
        assert_eq!(
            restore_with_tail(b"\x1b[>5u\x1b[>1u", b"\x1b[=3u"),
            b"\x1b[>5u\x1b[>0u"
        );
    }

    // --- mutually exclusive groups ---

    /// xterm holds one `activeProtocol`, so the last mode set wins. A fixed emit order would
    /// restore any-event tracking here and flood the app with motion reports.
    #[test]
    fn the_last_mouse_protocol_set_wins() {
        assert_eq!(restore(&[b"\x1b[?1003h\x1b[?1002h"]), b"\x1b[?1002h");
        assert_eq!(restore(&[b"\x1b[?1002h\x1b[?1003h"]), b"\x1b[?1003h");
        assert_eq!(restore(&[b"\x1b[?1000h\x1b[?9h"]), b"\x1b[?9h");
    }

    /// Resetting any member of the group turns reporting off in xterm, not just that mode.
    #[test]
    fn resetting_one_mouse_protocol_disables_reporting() {
        assert_eq!(restore(&[b"\x1b[?1003h\x1b[?1000l"]), b"\x1b[?1000l");
    }

    #[test]
    fn the_last_mouse_encoding_set_wins() {
        assert_eq!(restore(&[b"\x1b[?1006h\x1b[?1016h"]), b"\x1b[?1016h");
        assert_eq!(restore(&[b"\x1b[?1016h\x1b[?1006h"]), b"\x1b[?1006h");
        assert_eq!(restore(&[b"\x1b[?1006h\x1b[?1016l"]), b"\x1b[?1006l");
    }

    /// xterm logs 1005/1015 as unsupported without touching the encoding slot, so they must not
    /// displace the encoding the app actually asked for.
    #[test]
    fn unsupported_encodings_do_not_displace_the_active_one() {
        assert_eq!(restore(&[b"\x1b[?1006h\x1b[?1005h"]), b"\x1b[?1006h");
        assert_eq!(restore(&[b"\x1b[?1006h\x1b[?1015h"]), b"\x1b[?1006h");
    }

    // --- resets ---

    /// `reset` after a crashed TUI emits RIS; keeping state across it would drag the pane back
    /// into the alt screen on the next attach.
    #[test]
    fn ris_clears_everything_tracked() {
        assert_eq!(restore(&[b"\x1b[?1049h\x1b[?1003h\x1b[>1u\x1bc"]), b"");
        assert_eq!(restore(&[b"\x1b[?1049h\x1bc\x1b[?25l"]), b"\x1b[?25l");
    }

    /// DECSTR returns bracketed paste, focus reporting and the cursor to xterm's defaults, so
    /// the tracker has nothing left to assert about them.
    #[test]
    fn decstr_clears_the_modes_xterm_soft_resets() {
        assert_eq!(restore(&[b"\x1b[?2004h\x1b[?1004h\x1b[?25l\x1b[!p"]), b"");
        assert_eq!(restore(&[b"\x1b[?2004h\x1b[!p\x1b[?2004h"]), b"\x1b[?2004h");
        assert_eq!(
            restore(&[b"\x1b[>1u\x1b[?1049h\x1b[>5u\x1b[!p\x1b[?1049l"]),
            b""
        );
    }

    /// `softReset` never touches xterm's mouse service, and the alt buffer survives it too.
    /// Clearing either here would drop state the client keeps.
    #[test]
    fn decstr_leaves_the_buffer_and_mouse_state_alone() {
        assert_eq!(
            restore(&[b"\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[!p"]),
            b"\x1b[?1049h\x1b[?1003h\x1b[?1006h"
        );
    }

    /// RIS leaves the alt screen, so a tail that crosses it still starts where the app was.
    #[test]
    fn a_tail_that_crosses_a_ris_starts_in_the_alt_buffer() {
        assert_eq!(
            restore_with_tail(b"\x1b[?1049h", b"frame\x1bc$ "),
            b"\x1b[?1049h"
        );
    }

    #[test]
    fn a_client_that_missed_a_ris_is_taken_out_of_the_alt_screen() {
        assert_eq!(
            switch_after_gap(b"\x1b[?1049h", b"frame\x1bc", b"$ "),
            b"\x1b[<32u\x1b[?1049l\x1b[<32u"
        );
    }

    #[test]
    fn ris_leaves_the_scanner_usable() {
        let modes = tracker(&[b"\x1bc\x1b[?1049h"]);
        assert_eq!(modes.restore_prefix(b""), b"\x1b[?1049h");
    }

    // --- scanner robustness ---

    #[test]
    fn string_payloads_need_a_real_introducer_to_count() {
        assert_eq!(restore(&[b"\x1b]0;window [?1049h\x07"]), b"");
    }

    #[test]
    fn output_after_a_string_sequence_is_tracked_again() {
        assert_eq!(restore(&[b"\x1b]0;title\x07\x1b[?1049h"]), b"\x1b[?1049h");
        assert_eq!(restore(&[b"\x1bPq;1;2\x1b\\\x1b[?1049h"]), b"\x1b[?1049h");
    }

    /// xterm's transition table sends `ESC` to the escape state from anywhere, so a DCS whose
    /// payload holds an escape sequence really does execute it. Diverging here in either
    /// direction would restore modes the client is not in.
    #[test]
    fn esc_inside_a_string_aborts_it_the_way_xterm_does() {
        assert_eq!(
            restore(&[b"\x1bPtmux;\x1b\x1b[?1049h\x1b\\"]),
            b"\x1b[?1049h"
        );
    }

    #[test]
    fn c0_controls_do_not_break_a_sequence_in_flight() {
        assert_eq!(restore(&[b"\x1b[?10\r49h"]), b"\x1b[?1049h");
    }

    #[test]
    fn can_and_sub_abort_a_sequence_in_flight() {
        assert_eq!(restore(&[b"\x1b[?10\x1849h"]), b"");
        assert_eq!(restore(&[b"\x1b[?10\x1a49h"]), b"");
    }

    #[test]
    fn overlong_parameters_do_not_grow_the_buffer_or_match() {
        let mut modes = TerminalModes::default();
        modes.feed(b"\x1b[");
        modes.feed(&b"1".repeat(4096));
        modes.feed(b"?1049h");
        assert!(modes.csi.len() <= MAX_CSI_PARAMS);
        assert_eq!(modes.restore_prefix(b""), b"");
        // The ignored sequence ended at its final byte, so tracking resumes.
        modes.feed(b"\x1b[?1049h");
        assert_eq!(modes.restore_prefix(b""), b"\x1b[?1049h");
    }

    #[test]
    fn kitty_keyboard_stack_round_trips() {
        assert_eq!(restore(&[b"\x1b[>1u\x1b[>5u"]), b"\x1b[>1u\x1b[>5u");
    }

    #[test]
    fn kitty_keyboard_pop_removes_entries() {
        assert_eq!(restore(&[b"\x1b[>1u\x1b[>5u\x1b[<1u"]), b"\x1b[>1u");
        assert_eq!(restore(&[b"\x1b[>1u\x1b[>5u\x1b[<9u"]), b"");
        // A pop with no push must not underflow.
        assert_eq!(restore(&[b"\x1b[<3u"]), b"");
        // xterm pops at least one entry.
        assert_eq!(restore(&[b"\x1b[>1u\x1b[>5u\x1b[<0u"]), b"\x1b[>1u");
        // An emptied stack leaves 0 in force in xterm, even when its last entry was not 0.
        assert_eq!(restore(&[b"\x1b[=5u\x1b[>1u\x1b[<1u"]), b"");
    }

    /// xterm keeps the flags in force apart from the stack, so a set lands even with nothing
    /// pushed, and a fresh client can only be brought there by a set of its own.
    #[test]
    fn kitty_keyboard_set_replaces_the_flags_in_force() {
        assert_eq!(restore(&[b"\x1b[>1u\x1b[=13;1u"]), b"\x1b[>13u");
        assert_eq!(restore(&[b"\x1b[=13;1u"]), b"\x1b[=13u");
        assert_eq!(restore(&[b"\x1b[=5u\x1b[>1u"]), b"\x1b[=5u\x1b[>1u");
    }

    #[test]
    fn kitty_keyboard_stack_depth_is_bounded() {
        let mut modes = TerminalModes::default();
        for _ in 0..MAX_KITTY_STACK * 2 {
            modes.feed(b"\x1b[>1u");
        }
        assert_eq!(modes.kitty.buffer(false).stack.len(), MAX_KITTY_STACK);
    }

    #[test]
    fn byte_at_a_time_matches_whole_chunk_parsing() {
        let stream = b"\x1b[?1049h\x1b]0;t\x07\x1b[?1003h\x1b[?1006h\x1b[>1u\x1b[?25l";
        let mut split = TerminalModes::default();
        for &b in stream {
            split.feed(&[b]);
        }
        let whole = tracker(&[stream]);
        assert_eq!(split.restore_prefix(b""), whole.restore_prefix(b""));
        assert!(!whole.restore_prefix(b"").is_empty());
    }
}
