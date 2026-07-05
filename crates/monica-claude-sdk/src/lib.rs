//! Drive an interactive Claude Code session in Monica's Workbench by injecting input
//! into its PTY over the ptyd Unix socket, bypassing the desktop app entirely.
//!
//! Send-only for now: text goes in as a bracketed paste followed by a delayed
//! carriage return, mimicking a human pasting then pressing Enter in a real terminal.
//! Session creation and response reading are out of scope.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use monica_domain::TerminalSession;
use monica_paths as paths;
use monica_storage_sqlite::SqliteStore;
use monica_terminal_client::PtydClient;
use monica_terminal_protocol::{RequestOp, ResponseBody, PROTOCOL_VERSION};

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

/// The session currently driving `tab_id`. A tab respawn always inserts a fresh row,
/// so only the most recently created session can still be live.
pub fn resolve_tab_session(store: &SqliteStore, tab_id: &str) -> Result<TerminalSession> {
    store
        .latest_terminal_session_for_tab(tab_id)?
        .with_context(|| format!("tab {tab_id} has no terminal session"))
}

/// Connect to the ptyd socket for the current `MONICA_HOME` and verify the protocol
/// version. Incoming Output/Exit events are discarded (this client never attaches).
pub fn connect_ptyd() -> Result<PtydClient> {
    let socket = paths::ptyd_socket_path()?;
    let client = PtydClient::connect(&socket, |_| {})?;
    let version = client.hello()?;
    if version != PROTOCOL_VERSION {
        bail!("ptyd protocol version mismatch: daemon={version}, client={PROTOCOL_VERSION}");
    }
    Ok(client)
}

/// `Write` is a notification the daemon never answers, so writing to a dead session
/// fails silently. Listing sessions beforehand is the only available liveness check.
pub fn ensure_session_running(client: &PtydClient, session_id: &str) -> Result<()> {
    let ResponseBody::Sessions { sessions } = client.request(RequestOp::List)? else {
        bail!("unexpected response to list request");
    };
    match sessions.iter().find(|s| s.session_id == session_id) {
        Some(info) if info.running => Ok(()),
        Some(info) => bail!(
            "session {session_id} has exited (exit_code: {:?})",
            info.exit_code
        ),
        None => bail!("session {session_id} is not known to ptyd (tab closed or daemon restarted?)"),
    }
}

/// Paste `text` into the session's PTY and submit it with a delayed Enter.
pub fn send_text(client: &PtydClient, session_id: &str, text: &str) -> Result<()> {
    client.notify(RequestOp::Write {
        session_id: session_id.to_string(),
        data: BASE64.encode(bracketed_paste_bytes(text)),
    })?;
    std::thread::sleep(SUBMIT_DELAY);
    client.notify(RequestOp::Write {
        session_id: session_id.to_string(),
        data: BASE64.encode(b"\r"),
    })?;
    Ok(())
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
        assert_eq!(
            bracketed_paste_bytes("\x1b[201\x1b[201~~"),
            b"\x1b[200~\x1b[201~"
        );
    }
}
