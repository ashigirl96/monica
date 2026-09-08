//! Tracks the terminal modes an application turned on so `attach` can restore them ahead of
//! the replay tail. Escape sequences are state *transitions*, not state: an app that sends
//! `?1049h` once at startup leaves nothing in the transcript tail for a reconnecting client to
//! learn the alt screen from, so the client ends up with mouse reporting on while its buffer
//! says `normal` -- a combination no real terminal can be in. tmux restores modes the same way
//! on re-attach.

/// Modes worth restoring, in the order they are emitted. `1049` leads so the buffer switch
/// happens before the replay body lands in it.
const TRACKED_MODES: [u16; 8] = [1049, 1000, 1002, 1003, 1006, 2004, 1004, 25];

/// Parameter bytes past this are a malformed or hostile sequence, never a mode we track.
const MAX_CSI_PARAMS: usize = 64;

const MAX_KITTY_STACK: usize = 32;

/// Mirrors the subset of xterm's VT500 transition table that CSI dispatch depends on. The
/// client's parser is the yardstick, not the spec: a tracker that disagrees with it would
/// restore modes the client is not actually in. Notably `ESC` aborts whatever is in flight
/// from any state, which is why OSC/DCS payloads need no state of their own -- their bytes
/// can only reach a CSI through an `ESC` that xterm would honour too.
#[derive(Default, PartialEq)]
enum Scan {
    #[default]
    Ground,
    Esc,
    Csi,
    /// Parameters overflowed; swallow bytes until the final one.
    CsiIgnore,
}

#[derive(Default)]
pub struct TerminalModes {
    scan: Scan,
    csi: Vec<u8>,
    /// Parallel to `TRACKED_MODES`; `None` means never observed, so the peer's default holds.
    states: [Option<bool>; TRACKED_MODES.len()],
    kitty_stack: Vec<u32>,
}

impl TerminalModes {
    /// Feed a chunk of PTY output. Sequences split across chunks resume from the kept state.
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.step(b);
        }
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
                for param in params.split(|&b| b == b';') {
                    if let Some(index) = std::str::from_utf8(param)
                        .ok()
                        .and_then(|s| s.parse::<u16>().ok())
                        .and_then(|mode| TRACKED_MODES.iter().position(|&m| m == mode))
                    {
                        self.states[index] = Some(on);
                    }
                }
            }
            (b'>', b'u') => {
                let flags = parse_u32(params).unwrap_or(0);
                if self.kitty_stack.len() < MAX_KITTY_STACK {
                    self.kitty_stack.push(flags);
                }
            }
            (b'<', b'u') => {
                let count = parse_u32(params).unwrap_or(1) as usize;
                let keep = self.kitty_stack.len().saturating_sub(count);
                self.kitty_stack.truncate(keep);
            }
            (b'=', b'u') => {
                let flags = params
                    .split(|&b| b == b';')
                    .next()
                    .and_then(parse_u32)
                    .unwrap_or(0);
                if let Some(top) = self.kitty_stack.last_mut() {
                    *top = flags;
                }
            }
            _ => {}
        }
    }

    /// Sequences that put a fresh terminal into the state observed so far. Applying this
    /// followed by the transcript tail always lands on the current state: for any mode the
    /// tail's last transition is the current one (a later transition would itself be in the
    /// tail), and modes the tail never touches keep what this prefix set.
    pub fn restore_sequence(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (index, mode) in TRACKED_MODES.iter().enumerate() {
            if let Some(on) = self.states[index] {
                let final_byte = if on { 'h' } else { 'l' };
                out.extend_from_slice(format!("\x1b[?{mode}{final_byte}").as_bytes());
            }
        }
        for flags in &self.kitty_stack {
            out.extend_from_slice(format!("\x1b[>{flags}u").as_bytes());
        }
        out
    }
}

fn parse_u32(bytes: &[u8]) -> Option<u32> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restore(chunks: &[&[u8]]) -> Vec<u8> {
        let mut modes = TerminalModes::default();
        for chunk in chunks {
            modes.feed(chunk);
        }
        modes.restore_sequence()
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
            b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l\x1b[>1u"
        );
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
            restore(&[b"\x1b[?1000;1002;1006h"]),
            b"\x1b[?1000h\x1b[?1002h\x1b[?1006h"
        );
    }

    #[test]
    fn reset_overrides_an_earlier_set() {
        assert_eq!(restore(&[b"\x1b[?25l\x1b[?25h\x1b[?25l"]), b"\x1b[?25l");
    }

    #[test]
    fn alt_screen_leads_the_restore_regardless_of_arrival_order() {
        let out = restore(&[b"\x1b[?2004h\x1b[?1002h\x1b[?1049h"]);
        assert_eq!(out, b"\x1b[?1049h\x1b[?1002h\x1b[?2004h");
    }

    #[test]
    fn untracked_modes_and_other_finals_are_ignored() {
        assert_eq!(restore(&[b"\x1b[?7h\x1b[?12l\x1b[2J\x1b[38;5;196m"]), b"");
    }

    #[test]
    fn string_payloads_need_a_real_introducer_to_count() {
        // An OSC title carrying the literal text: no ESC, so no sequence.
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
        assert_eq!(modes.restore_sequence(), b"");
        // The ignored sequence ended at its final byte, so tracking resumes.
        modes.feed(b"\x1b[?1049h");
        assert_eq!(modes.restore_sequence(), b"\x1b[?1049h");
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
        let stream = b"\x1b[?1049h\x1b]0;t\x07\x1b[?1000;1006h\x1b[>1u\x1b[?25l";
        let mut split = TerminalModes::default();
        for &b in stream {
            split.feed(&[b]);
        }
        let mut whole = TerminalModes::default();
        whole.feed(stream);
        assert_eq!(split.restore_sequence(), whole.restore_sequence());
        assert!(!whole.restore_sequence().is_empty());
    }
}
