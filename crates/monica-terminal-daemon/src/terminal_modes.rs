//! Tracks the terminal modes an application turned on so `attach` can restore the ones the
//! replay tail cannot convey. Escape sequences are state *transitions*, not state: an app that
//! sends `?1049h` once at startup leaves nothing in a 256 KB tail for a reconnecting client to
//! learn the alt screen from, so the client ends up with mouse reporting on while its buffer
//! says `normal` -- a combination no real terminal can be in. tmux restores modes the same way
//! on re-attach.
//!
//! Every grouping here mirrors what xterm actually keys off, because the client's parser is the
//! yardstick: restoring a mode xterm ignores, or restoring two modes that xterm treats as one
//! slot, would leave the daemon's idea of the session out of step with what the user sees.

/// Independent flags, in the order they are restored. These are also exactly what xterm's
/// DECSTR returns to its defaults -- the mouse protocol and encoding live in a service
/// `softReset` never touches, and neither does the alt buffer, so those stay put.
const TRACKED_FLAGS: [u16; 3] = [2004, 1004, 25];

/// Handled apart from the flags because it decides *where* output lands rather than just how it
/// is reported, which means `restore_prefix` needs its value at the replay boundary, not its
/// latest value.
const ALT_SCREEN: u16 = 1049;

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
    kitty_stack: Vec<u32>,
    /// A stack cannot be rebuilt from a suffix, so attach needs to know whether the tail
    /// touches it at all rather than just where it ended up.
    kitty_touched: bool,
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
                // The stream offset is not terminal state and must survive, or every later
                // boundary would be measured against the wrong origin.
                b'c' => {
                    let stream_len = self.stream_len;
                    *self = Self::default();
                    self.stream_len = stream_len;
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
                    if mode == ALT_SCREEN {
                        alt_switch = Some(on);
                        continue;
                    }
                    let slot = if on { Exclusive::On(mode) } else { Exclusive::Off };
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
            (b'!', b'p') => self.flags = [None; TRACKED_FLAGS.len()],
            (b'>', b'u') => {
                self.kitty_touched = true;
                if self.kitty_stack.len() < MAX_KITTY_STACK {
                    self.kitty_stack.push(parse_u32(params).unwrap_or(0));
                }
            }
            (b'<', b'u') => {
                self.kitty_touched = true;
                let count = parse_u32(params).unwrap_or(1) as usize;
                let keep = self.kitty_stack.len().saturating_sub(count);
                self.kitty_stack.truncate(keep);
            }
            (b'=', b'u') => {
                self.kitty_touched = true;
                let flags = params.split(|&b| b == b';').next().and_then(parse_u32);
                if let Some(top) = self.kitty_stack.last_mut() {
                    *top = flags.unwrap_or(0);
                }
            }
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
    /// `tail` must be a suffix of what has been fed, which is what `attach` hands over.
    pub fn restore_prefix(&self, tail: &[u8]) -> Vec<u8> {
        let mut in_tail = Self::default();
        in_tail.feed(tail);
        let boundary = self.stream_len.saturating_sub(tail.len() as u64);

        let mut out = Vec::new();
        // The buffer switch leads so the replay body lands in the right buffer. Only the alt
        // case needs saying: a fresh client is on the normal buffer already.
        if self.alt_screen_at(boundary) == Some(true) {
            push_mode(&mut out, ALT_SCREEN, true);
        }
        for (index, mode) in TRACKED_FLAGS.iter().enumerate() {
            let restored = if in_tail.flags[index].is_some() { None } else { self.flags[index] };
            if let Some(on) = restored {
                push_mode(&mut out, *mode, on);
            }
        }
        if in_tail.mouse_protocol == Exclusive::Unobserved {
            push_exclusive(&mut out, self.mouse_protocol, MOUSE_PROTOCOLS[1]);
        }
        if in_tail.mouse_encoding == Exclusive::Unobserved {
            push_exclusive(&mut out, self.mouse_encoding, MOUSE_ENCODINGS[0]);
        }
        if !in_tail.kitty_touched {
            for flags in &self.kitty_stack {
                out.extend_from_slice(format!("\x1b[>{flags}u").as_bytes());
            }
        }
        out
    }
}

enum Slot {
    Flag(usize),
    MouseProtocol,
    MouseEncoding,
}

fn classify(mode: u16) -> Option<Slot> {
    if let Some(index) = TRACKED_FLAGS.iter().position(|&m| m == mode) {
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

fn parse_u16(bytes: &[u8]) -> Option<u16> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
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
        assert_eq!(restore_with_tail(startup, tail), b"\x1b[?1049h\x1b[?2004h\x1b[?1004h");
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
        assert_eq!(restore(&[b"\x1b[?1049;2004;25h"]), b"\x1b[?1049h\x1b[?2004h\x1b[?25h");
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
            restore_with_tail(b"\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h", b"later\x1b[?25l"),
            b"\x1b[?1049h\x1b[?2004h\x1b[?1003h\x1b[?1006h"
        );
    }

    #[test]
    fn a_kitty_stack_the_tail_touches_is_left_alone() {
        assert_eq!(restore_with_tail(b"\x1b[>1u", b"\x1b[>5u"), b"");
        assert_eq!(restore_with_tail(b"\x1b[>1u\x1b[>5u", b"nothing"), b"\x1b[>1u\x1b[>5u");
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
        assert_eq!(restore(&[b"\x1bPtmux;\x1b\x1b[?1049h\x1b\\"]), b"\x1b[?1049h");
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
    }

    #[test]
    fn kitty_keyboard_set_replaces_the_top_entry() {
        assert_eq!(restore(&[b"\x1b[>1u\x1b[=13;1u"]), b"\x1b[>13u");
        // With an empty stack there is nothing to set.
        assert_eq!(restore(&[b"\x1b[=13;1u"]), b"");
    }

    #[test]
    fn kitty_keyboard_stack_depth_is_bounded() {
        let mut modes = TerminalModes::default();
        for _ in 0..MAX_KITTY_STACK * 2 {
            modes.feed(b"\x1b[>1u");
        }
        assert_eq!(modes.kitty_stack.len(), MAX_KITTY_STACK);
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
