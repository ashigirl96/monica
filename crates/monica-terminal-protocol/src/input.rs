//! Encoding for programmatic text input into a PTY, shared by every writer that
//! submits prompts (the app's send path and the SDK's escape hatch).

use std::time::Duration;

/// Delay between the paste write and the submitting `\r`. Claude Code (Ink) applies
/// pasted text to its input buffer asynchronously, so the Enter must arrive as a
/// separate stdin read or it can be consumed before the paste lands. Warp's Claude
/// integration ships the same two-step strategy ("DelayedEnter") with 50ms.
pub const SUBMIT_DELAY: Duration = Duration::from_millis(150);

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// Wrap `text` in a bracketed paste, normalizing newlines to `\r` the way terminal
/// emulators do when pasting (xterm.js behavior). Inside the paste markers the TUI
/// treats `\r` as a literal newline, never as a submit, and mode-switch prefixes
/// like `!` stay literal text.
///
/// Embedded paste-boundary sequences are stripped: an embedded `ESC[201~` would end
/// the paste early and turn the rest of the text into live key input (paste
/// injection). Stripping repeats until nothing matches, because removing one
/// occurrence can splice a new terminator together from the surrounding bytes.
pub fn bracketed_paste_bytes(text: &str) -> Vec<u8> {
    let mut normalized = text.replace("\r\n", "\r").replace('\n', "\r");
    while normalized.contains(PASTE_END) || normalized.contains(PASTE_START) {
        normalized = normalized.replace(PASTE_END, "").replace(PASTE_START, "");
    }
    let mut bytes = Vec::with_capacity(PASTE_START.len() + normalized.len() + PASTE_END.len());
    bytes.extend_from_slice(PASTE_START.as_bytes());
    bytes.extend_from_slice(normalized.as_bytes());
    bytes.extend_from_slice(PASTE_END.as_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_text_in_paste_markers() {
        assert_eq!(bracketed_paste_bytes("hi"), b"\x1b[200~hi\x1b[201~");
    }

    #[test]
    fn normalizes_lf_to_cr() {
        assert_eq!(bracketed_paste_bytes("a\nb\nc"), b"\x1b[200~a\rb\rc\x1b[201~");
    }

    #[test]
    fn normalizes_crlf_to_single_cr() {
        assert_eq!(bracketed_paste_bytes("a\r\nb"), b"\x1b[200~a\rb\x1b[201~");
    }

    #[test]
    fn passes_utf8_through_unchanged() {
        let text = "こんにちは、世界";
        let bytes = bracketed_paste_bytes(text);
        let inner = &bytes[PASTE_START.len()..bytes.len() - PASTE_END.len()];
        assert_eq!(inner, text.as_bytes());
    }

    #[test]
    fn strips_embedded_paste_boundaries() {
        assert_eq!(bracketed_paste_bytes("a\x1b[201~b"), b"\x1b[200~ab\x1b[201~");
        assert_eq!(bracketed_paste_bytes("a\x1b[200~b"), b"\x1b[200~ab\x1b[201~");
    }

    #[test]
    fn strips_paste_terminator_reassembled_by_removal() {
        assert_eq!(bracketed_paste_bytes("\x1b[201\x1b[201~~"), b"\x1b[200~\x1b[201~");
    }
}
