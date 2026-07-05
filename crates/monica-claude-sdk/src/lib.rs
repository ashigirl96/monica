//! Drive interactive Claude Code sessions in Monica's Workbench without touching the
//! webview: create sessions through the running app's SDK control socket
//! ([`open_session`]), and inject input straight into their PTYs over the ptyd Unix
//! socket ([`send_text`]).
//!
//! Input goes in as a bracketed paste followed by a delayed carriage return, mimicking
//! a human pasting then pressing Enter in a real terminal. Response reading is out of
//! scope (session JSONL / hooks arrive in later MVPs).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use monica_domain::TerminalSession;
use monica_paths as paths;
use monica_sdk_protocol::{
    SdkRequest, SdkRequestOp, SdkResponse, PROTOCOL_VERSION as SDK_PROTOCOL_VERSION,
};
use monica_storage_sqlite::SqliteStore;
use monica_terminal_client::PtydClient;
use monica_terminal_protocol::{RequestOp, ResponseBody, PROTOCOL_VERSION};

pub use monica_sdk_protocol::SdkSessionInfo;

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

/// Parameters for [`open_session`]. `cwd` must be an existing directory; `model` and
/// `title` are optional (`title` is the tab's initial label until the shell retitles it).
#[derive(Debug, Clone)]
pub struct OpenSessionParams {
    pub cwd: String,
    pub model: Option<String>,
    pub title: Option<String>,
    /// Idempotency key (a UUID). `None` mints one client-side before the request goes
    /// out, so every open is retry-safe by construction; supply your own only when the
    /// caller already persisted an id it wants the session to run under.
    pub claude_session_id: Option<String>,
}

/// Control-socket round-trip timeout (mirrors `PtydClient`'s request timeout).
const OPEN_SESSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Ask the running Monica app to create a Claude Code session in the Workbench's "sdk"
/// runspace. The app pre-mints the Claude session id, spawns the shell, and launches
/// `claude --session-id <uuid>` itself; the returned info carries every id needed to
/// locate the transcript (`~/.claude/projects/<slug>/<uuid>.jsonl`) or send input later.
///
/// Returns only after the daemon has acknowledged the launch command in the session's PTY,
/// so a follow-up [`send_text`] cannot land at the raw shell prompt while the shell is
/// still the foreground reader. Claude's own boot is asynchronous and NOT verified here:
/// if the `claude` binary is missing or exits during startup, the tab is left at a shell
/// prompt. The reliable readiness signal is the transcript file
/// (`~/.claude/projects/<slug>/<claude_session_id>.jsonl`) appearing; hook/JSONL-based
/// readiness APIs are MVP4/MVP5 scope.
///
/// Retry semantics: a server-reported error means no session is left behind (a failed
/// launch is torn down), so retrying is safe. A transport failure after the request was
/// sent (timeout, dropped connection) leaves the outcome unknown — but the request
/// carries a `claude_session_id` minted client-side, so retrying with the *same params
/// value* (keep the id the first call filled in, or pre-fill your own) resolves to the
/// original session instead of creating a second one. Retrying with a freshly minted id
/// opens a second session; check the Workbench first if that matters.
pub fn open_session(params: OpenSessionParams) -> Result<SdkSessionInfo> {
    open_session_at(&paths::sdk_socket_path()?, params)
}

/// [`open_session`] against an explicit control-socket path instead of the one derived
/// from `MONICA_HOME`.
pub fn open_session_at(socket: &Path, params: OpenSessionParams) -> Result<SdkSessionInfo> {
    // Resolved on this side of the IPC boundary: a relative path means the *caller's*
    // working directory, which the app process has no way to know.
    let cwd = std::path::absolute(&params.cwd)
        .with_context(|| format!("failed to resolve cwd {}", params.cwd))?
        .to_string_lossy()
        .into_owned();
    let claude_session_id = params
        .claude_session_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let stream = UnixStream::connect(socket).with_context(|| {
        format!(
            "failed to connect to {} (is the Monica app running?)",
            socket.display()
        )
    })?;
    stream.set_read_timeout(Some(OPEN_SESSION_TIMEOUT))?;

    let request = SdkRequest {
        version: SDK_PROTOCOL_VERSION,
        op: SdkRequestOp::OpenSdkSession {
            cwd,
            model: params.model,
            title: params.title,
            claude_session_id: Some(claude_session_id.clone()),
        },
    };
    let mut payload = serde_json::to_string(&request)?;
    payload.push('\n');
    let mut writer = stream.try_clone()?;
    writer.write_all(payload.as_bytes())?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    // Past this point a failure no longer implies "nothing happened": the request was
    // already sent, so a lost response leaves the session possibly running — but it runs
    // under the id this call sent, so a retry carrying that id resolves to it.
    let recovery_hint = || {
        format!(
            "the session may still have been created; retry with \
             claude_session_id={claude_session_id} to resolve to it instead of \
             opening a second session"
        )
    };
    reader.read_line(&mut line).with_context(|| {
        format!("failed to read a response from the sdk control socket; {}", recovery_hint())
    })?;
    if line.trim().is_empty() {
        bail!("sdk control socket closed without a response; {}", recovery_hint());
    }
    match serde_json::from_str::<SdkResponse>(&line)? {
        SdkResponse::Ok { session } => {
            // An older server ignores unknown request fields, silently minting its own id
            // — which would make every "safe retry" open another session. The id is echoed
            // in the response, so a mismatch identifies that server before the caller
            // relies on idempotency.
            if session.claude_session_id != claude_session_id {
                bail!(
                    "server ignored the client-supplied claude_session_id (an older Monica \
                     app?): sent {claude_session_id}, got {}; the session IS running under \
                     the returned id, but retries are not idempotent against this server",
                    session.claude_session_id
                );
            }
            Ok(session)
        }
        SdkResponse::Err { error } => bail!("open_session rejected: {error}"),
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
