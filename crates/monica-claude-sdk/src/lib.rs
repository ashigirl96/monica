//! Drive interactive Claude Code sessions in Monica's Workbench without touching the
//! webview. The primary API is [`ClaudeRuntime`] / [`ClaudeSession`]: create or attach
//! to sessions through the running app's Agent Runtime control socket, send prompts,
//! and stream events (assistant messages, tool uses, state changes) back.
//!
//! The free functions below are the lower-level pieces: [`open_session`] is the raw
//! open op, and [`send_text`] writes straight into a PTY over the ptyd socket (the
//! escape hatch — it bypasses the app's Busy tracking entirely). Input goes in as a
//! bracketed paste followed by a delayed carriage return, mimicking a human pasting
//! then pressing Enter in a real terminal.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use monica_domain::TerminalSession;
use monica_paths as paths;
use monica_agent_runtime_protocol::{
    RuntimeRequest, RuntimeRequestOp, RuntimeResponse, PROTOCOL_VERSION as RUNTIME_PROTOCOL_VERSION,
};
use monica_storage_sqlite::SqliteStore;
use monica_terminal_client::PtydClient;
use monica_terminal_protocol::{RequestOp, ResponseBody, PROTOCOL_VERSION};

mod runtime;
mod session;

pub use monica_agent_runtime_protocol::{ClaudeSessionInfo, ClaudeSessionSummary, SessionEvent};
pub use runtime::{ClaudeRuntime, CreateSessionParams};
pub use session::{ClaudeSession, SessionBusy, SessionEnded};

pub use monica_terminal_protocol::{bracketed_paste_bytes, SUBMIT_DELAY};

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
    /// out; if the response is then lost, the minted key comes back inside the error as
    /// a downcastable [`OpenSessionIndeterminate`], so the retry can carry it. Supply
    /// your own when the caller already persisted an id it wants the session to run
    /// under.
    pub claude_session_id: Option<String>,
}

/// The request left this process but no usable response came back, so the outcome is
/// unknown: the session may be running under [`Self::claude_session_id`]. Recover this
/// from the `anyhow` chain (`err.downcast_ref::<OpenSessionIndeterminate>()`) and retry
/// with that id — a server that did create the session answers with it instead of opening
/// a second one, a launch interrupted mid-flight is refused explicitly, and if nothing was
/// created the retry simply launches under that same id.
#[derive(Debug, Clone)]
pub struct OpenSessionIndeterminate {
    pub claude_session_id: String,
}

impl std::fmt::Display for OpenSessionIndeterminate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the session may still have been created; retry with claude_session_id={} to \
             resolve to it instead of opening a second session",
            self.claude_session_id
        )
    }
}

impl std::error::Error for OpenSessionIndeterminate {}

/// Control-socket round-trip timeout (mirrors `PtydClient`'s request timeout).
const OPEN_SESSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Ask the running Monica app to create a Claude Code session in the Workbench's "agent-runtime"
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
/// Retry semantics: a determinate server-reported error means no session is left behind
/// (a failed launch is torn down), so retrying is safe. Every other failure once the
/// request started going out — a failed write, timeout, dropped connection, truncated or
/// unparseable response, or the server answering that it cannot resolve the outcome
/// itself (an unconfirmed launch reservation) — leaves the outcome unknown: that error
/// carries a downcastable [`OpenSessionIndeterminate`] holding the `claude_session_id`
/// the request ran under (supplied or client-minted), and retrying with that id resolves
/// to the original session instead of creating a second one. Retrying with a fresh id
/// after an indeterminate failure can open a second session; check the Workbench first
/// if that matters.
pub fn open_session(params: OpenSessionParams) -> Result<ClaudeSessionInfo> {
    open_session_at(&paths::agent_runtime_socket_path()?, params)
}

/// [`open_session`] against an explicit control-socket path instead of the one derived
/// from `MONICA_HOME`.
pub fn open_session_at(socket: &Path, params: OpenSessionParams) -> Result<ClaudeSessionInfo> {
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

    let request = RuntimeRequest {
        version: RUNTIME_PROTOCOL_VERSION,
        op: RuntimeRequestOp::OpenClaudeSession {
            cwd,
            model: params.model,
            title: params.title,
            claude_session_id: Some(claude_session_id.clone()),
        },
    };
    let mut payload = serde_json::to_string(&request)?;
    payload.push('\n');
    let mut writer = stream.try_clone()?;
    // From the first write on, a failure no longer implies "nothing happened": even a
    // partial write can reach the server as a complete request (closing the socket
    // flushes what was sent, and read_line returns it on EOF), and a lost response
    // leaves the session possibly running — but it runs under the id this call sent.
    // That id must survive every such failure in a structured form (not just error
    // prose), or a caller who minted through us could never retry idempotently: hence
    // the downcastable OpenSessionIndeterminate in the chain. Only a parsed, determinate
    // server Err proves no session was left behind.
    let indeterminate = |context: String| {
        anyhow::Error::new(OpenSessionIndeterminate {
            claude_session_id: claude_session_id.clone(),
        })
        .context(context)
    };
    if let Err(e) = writer.write_all(payload.as_bytes()) {
        return Err(indeterminate(format!(
            "failed to send the request to the agent runtime control socket: {e}"
        )));
    }

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if let Err(e) = reader.read_line(&mut line) {
        return Err(indeterminate(format!(
            "failed to read a response from the agent runtime control socket: {e}"
        )));
    }
    if line.trim().is_empty() {
        return Err(indeterminate("agent runtime control socket closed without a response".to_string()));
    }
    let response: RuntimeResponse = match serde_json::from_str(&line) {
        Ok(response) => response,
        Err(e) => {
            // A truncated line still comes back from read_line (EOF ends it), so a server
            // that died mid-response surfaces here rather than as an I/O error.
            return Err(indeterminate(format!(
                "agent runtime control socket answered with an unparseable response: {e}"
            )));
        }
    };
    match response {
        RuntimeResponse::Ok { session } => {
            // Version negotiation makes this unreachable against real servers (v1 apps
            // reject v2 requests before launching), so a mismatch means a server that
            // claims v2 but broke the idempotency contract — fail loudly rather than let
            // "safe retries" open another session.
            if session.claude_session_id != claude_session_id {
                bail!(
                    "server ignored the client-supplied claude_session_id: sent \
                     {claude_session_id}, got {}; the session IS running under the \
                     returned id, but retries are not idempotent against this server",
                    session.claude_session_id
                );
            }
            Ok(session)
        }
        // The server can be unable to determine the outcome too (the id maps to a launch
        // reservation still unconfirmed — an open in flight elsewhere, or one that was
        // interrupted). That is the same "may be running under this id" situation as a
        // lost response, and it must not read as "rejected, nothing created".
        RuntimeResponse::Err { error, indeterminate: true, .. } => {
            Err(indeterminate(format!("open_session did not resolve: {error}")))
        }
        RuntimeResponse::Err { error, indeterminate: false, .. } => {
            bail!("open_session rejected: {error}")
        }
        other => bail!("unexpected response to open_claude_session: {other:?}"),
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
