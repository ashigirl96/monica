use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use monica_agent_runtime_protocol::{
    ClaudeSessionSummary, RuntimeRequest, RuntimeRequestOp, RuntimeResponse, PROTOCOL_VERSION,
};
use monica_paths as paths;

use crate::session::ClaudeSession;
use crate::{open_session_at, OpenSessionParams};

/// Round-trip timeout for one-shot control-socket ops (mirrors `open_session`'s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Parameters for [`ClaudeRuntime::create_session`] /
/// [`ClaudeRuntime::get_or_create_session`]. `cwd` must be an existing directory; `model`
/// and `title` are optional.
#[derive(Debug, Clone)]
pub struct CreateSessionParams {
    pub cwd: String,
    pub model: Option<String>,
    pub title: Option<String>,
}

/// Handle to the running Monica app's Agent Runtime control socket. Holds no connection —
/// each op opens its own (one request/response pair per connection; subscriptions hold
/// theirs open inside [`ClaudeSession`]).
#[derive(Debug, Clone)]
pub struct ClaudeRuntime {
    socket: PathBuf,
}

impl ClaudeRuntime {
    /// Resolve the control socket for the current `MONICA_HOME`. Only path resolution —
    /// connectivity surfaces on the first op.
    pub fn connect() -> Result<Self> {
        Ok(Self { socket: paths::agent_runtime_socket_path()? })
    }

    /// [`ClaudeRuntime::connect`] against an explicit socket path.
    pub fn connect_at(socket: impl Into<PathBuf>) -> Self {
        Self { socket: socket.into() }
    }

    /// Create a fresh session (client-minted id) and subscribe to its events. The returned
    /// handle's subscription is established before this returns, so no event is lost
    /// between creation and the first [`ClaudeSession::next_event`].
    pub fn create_session(&self, params: CreateSessionParams) -> Result<ClaudeSession> {
        self.open(params, None)
    }

    /// Idempotent open: an id already mapped to a live session resolves to that session
    /// instead of creating a second one, so this doubles as "get". The id must be a UUID.
    pub fn get_or_create_session(
        &self,
        claude_session_id: &str,
        params: CreateSessionParams,
    ) -> Result<ClaudeSession> {
        self.open(params, Some(claude_session_id.to_string()))
    }

    pub fn list_sessions(&self) -> Result<Vec<ClaudeSessionSummary>> {
        match request_once(&self.socket, RuntimeRequestOp::ListSessions)? {
            RuntimeResponse::Sessions { sessions } => Ok(sessions),
            RuntimeResponse::Err { error, .. } => bail!("list_sessions rejected: {error}"),
            other => bail!("unexpected response to list_sessions: {other:?}"),
        }
    }

    /// Attach to an existing session (no create) and subscribe to its events.
    pub fn session(&self, claude_session_id: &str) -> Result<ClaudeSession> {
        let summary = self
            .list_sessions()?
            .into_iter()
            .find(|s| s.claude_session_id == claude_session_id)
            .with_context(|| format!("claude session {claude_session_id} not found"))?;
        ClaudeSession::attach(
            &self.socket,
            claude_session_id,
            summary.terminal_session_id.clone(),
            None,
        )
    }

    fn open(
        &self,
        params: CreateSessionParams,
        claude_session_id: Option<String>,
    ) -> Result<ClaudeSession> {
        let info = open_session_at(
            &self.socket,
            OpenSessionParams {
                cwd: params.cwd,
                model: params.model,
                title: params.title,
                claude_session_id,
            },
        )?;
        let terminal_session_id = info.session_id.clone();
        let claude_session_id = info.claude_session_id.clone();
        ClaudeSession::attach(&self.socket, &claude_session_id, terminal_session_id, Some(info))
    }
}

/// One request/response pair on a fresh connection. A transport failure after the write
/// leaves the outcome unknown — callers whose op is not idempotent (send) must not
/// auto-retry on it.
pub(crate) fn request_once(socket: &Path, op: RuntimeRequestOp) -> Result<RuntimeResponse> {
    let stream = UnixStream::connect(socket).with_context(|| {
        format!("failed to connect to {} (is the Monica app running?)", socket.display())
    })?;
    stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
    let request = RuntimeRequest { version: PROTOCOL_VERSION, op };
    let mut payload = serde_json::to_string(&request)?;
    payload.push('\n');
    let mut writer = stream.try_clone()?;
    writer
        .write_all(payload.as_bytes())
        .context("failed to send the request to the agent runtime control socket")?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .context("failed to read a response from the agent runtime control socket")?;
    if line.trim().is_empty() {
        bail!("agent runtime control socket closed without a response");
    }
    serde_json::from_str(&line)
        .context("agent runtime control socket answered with an unparseable response")
}
