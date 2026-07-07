use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use monica_agent_runtime_protocol::{
    ClaudeSessionInfo, RuntimeErrorCode, RuntimeRequest, RuntimeRequestOp, RuntimeResponse,
    SessionEvent, PROTOCOL_VERSION,
};
use monica_terminal_protocol::RequestOp;

use crate::runtime::request_once;

/// How long the constructor waits for the server's `ack` before giving up on the
/// subscription. Also the connection's permanent read timeout, which makes it the reader
/// thread's idle poll interval between server heartbeats (15s apart).
const SUBSCRIBE_ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// Events buffered between the reader thread and the consumer.
const EVENT_BUFFER: usize = 256;

/// The session rejected the message because one is already in flight (or it is still
/// launching). Recover from the `anyhow` chain via
/// `err.downcast_ref::<SessionBusy>()`, wait for [`ClaudeSession::wait_until_idle`], and
/// retry.
#[derive(Debug, Clone)]
pub struct SessionBusy;

impl std::fmt::Display for SessionBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the session is busy: one message may be in flight per session")
    }
}

impl std::error::Error for SessionBusy {}

/// The session has ended; no further messages or events. Recover from the `anyhow` chain
/// via `err.downcast_ref::<SessionEnded>()`.
#[derive(Debug, Clone)]
pub struct SessionEnded;

impl std::fmt::Display for SessionEnded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the claude session has ended")
    }
}

impl std::error::Error for SessionEnded {}

enum StreamItem {
    Event(SessionEvent),
    /// The stream is over: `None` for a clean EOF, `Some` for a wire/read failure.
    Closed(Option<String>),
}

/// A live Claude Code session: send prompts, stream events, interrupt. Holds a dedicated
/// `subscribe` connection whose reader thread feeds [`ClaudeSession::next_event`]; the
/// one-shot ops (send/interrupt) open their own connections. Dropping the handle closes
/// the subscription (the session itself keeps running).
pub struct ClaudeSession {
    socket: PathBuf,
    claude_session_id: String,
    terminal_session_id: String,
    info: Option<ClaudeSessionInfo>,
    events: Receiver<StreamItem>,
    stream: UnixStream,
    ended: bool,
}

impl std::fmt::Debug for ClaudeSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeSession")
            .field("claude_session_id", &self.claude_session_id)
            .field("terminal_session_id", &self.terminal_session_id)
            .field("ended", &self.ended)
            .finish_non_exhaustive()
    }
}

impl ClaudeSession {
    pub(crate) fn attach(
        socket: &Path,
        claude_session_id: &str,
        terminal_session_id: String,
        info: Option<ClaudeSessionInfo>,
    ) -> Result<Self> {
        let stream = UnixStream::connect(socket).with_context(|| {
            format!("failed to connect to {} (is the Monica app running?)", socket.display())
        })?;
        // One read timeout for the connection's whole life: the ack wait fails on it, and
        // the reader thread treats later timeouts as idle gaps between server heartbeats.
        // (Re-tuning it after the ack is not an option — setsockopt on a socket whose
        // peer already closed fails with EINVAL on macOS.)
        stream.set_read_timeout(Some(SUBSCRIBE_ACK_TIMEOUT))?;
        let request = RuntimeRequest {
            version: PROTOCOL_VERSION,
            op: RuntimeRequestOp::Subscribe { claude_session_id: claude_session_id.to_string() },
        };
        let mut payload = serde_json::to_string(&request)?;
        payload.push('\n');
        let mut writer = stream.try_clone()?;
        writer.write_all(payload.as_bytes()).context("failed to send the subscribe request")?;

        let mut reader = BufReader::new(stream.try_clone()?);
        // The ack is awaited here so an established subscription is part of this
        // constructor's contract: an event fired right after creation cannot be missed.
        let mut line = String::new();
        reader.read_line(&mut line).context("failed to read the subscribe ack")?;
        if line.trim().is_empty() {
            bail!("the agent runtime control socket closed without acknowledging the subscribe");
        }
        match serde_json::from_str(&line).context("unparseable subscribe response")? {
            RuntimeResponse::Ack => {}
            RuntimeResponse::Err { error, code, .. } => {
                // The marker is the root error so both `downcast_ref` and `chain()`
                // reach it; the human-readable rejection rides along as context.
                return Err(match code {
                    Some(RuntimeErrorCode::SessionEnded) => anyhow::Error::new(SessionEnded)
                        .context(format!("subscribe rejected: {error}")),
                    _ => anyhow::anyhow!("subscribe rejected: {error}"),
                });
            }
            other => bail!("unexpected subscribe response: {other:?}"),
        }

        let (tx, rx) = std::sync::mpsc::sync_channel(EVENT_BUFFER);
        std::thread::Builder::new()
            .name(format!("mcsdk-events-{claude_session_id}"))
            .spawn(move || read_events(reader, tx))
            .context("failed to spawn the event reader thread")?;

        Ok(Self {
            socket: socket.to_path_buf(),
            claude_session_id: claude_session_id.to_string(),
            terminal_session_id,
            info,
            events: rx,
            stream,
            ended: false,
        })
    }

    pub fn claude_session_id(&self) -> &str {
        &self.claude_session_id
    }

    /// The ptyd terminal session hosting this Claude process.
    pub fn terminal_session_id(&self) -> &str {
        &self.terminal_session_id
    }

    /// Full open-response info; `None` when the handle was attached to an existing
    /// session via [`crate::ClaudeRuntime::session`].
    pub fn info(&self) -> Option<&ClaudeSessionInfo> {
        self.info.as_ref()
    }

    /// Submit one user message. Accepted only while the session is idle: a `busy`
    /// rejection carries a downcastable [`SessionBusy`], an ended session a
    /// [`SessionEnded`]. NOT idempotent — a transport failure leaves the outcome unknown,
    /// so do not blindly resend on error.
    pub fn send_user_message(&self, text: &str) -> Result<()> {
        let response = request_once(
            &self.socket,
            RuntimeRequestOp::SendUserMessage {
                claude_session_id: self.claude_session_id.clone(),
                text: text.to_string(),
            },
        )
        .context("send_user_message did not resolve: whether the message reached claude is unknown — do not blindly resend")?;
        match response {
            RuntimeResponse::Ack => Ok(()),
            RuntimeResponse::Err { error, code, .. } => {
                let rejected = format!("send_user_message rejected: {error}");
                Err(match code {
                    Some(RuntimeErrorCode::Busy) => {
                        anyhow::Error::new(SessionBusy).context(rejected)
                    }
                    Some(RuntimeErrorCode::SessionEnded) => {
                        anyhow::Error::new(SessionEnded).context(rejected)
                    }
                    _ => anyhow::anyhow!(rejected),
                })
            }
            other => bail!("unexpected response to send_user_message: {other:?}"),
        }
    }

    /// Send ESC into the session's PTY to stop the current turn.
    pub fn interrupt(&self) -> Result<()> {
        match request_once(
            &self.socket,
            RuntimeRequestOp::InterruptSession {
                claude_session_id: self.claude_session_id.clone(),
            },
        )? {
            RuntimeResponse::Ack => Ok(()),
            RuntimeResponse::Err { error, .. } => bail!("interrupt rejected: {error}"),
            other => bail!("unexpected response to interrupt: {other:?}"),
        }
    }

    /// Next event, blocking until one arrives. After [`SessionEvent::Ended`] (or once the
    /// stream is lost) this returns an error — [`SessionEnded`] is downcastable in the
    /// former case.
    pub fn next_event(&mut self) -> Result<SessionEvent> {
        match self.events.recv() {
            Ok(item) => self.settle(item),
            Err(_) => self.closed(None),
        }
    }

    /// [`ClaudeSession::next_event`] with a timeout; `Ok(None)` when nothing arrived.
    pub fn next_event_timeout(&mut self, timeout: Duration) -> Result<Option<SessionEvent>> {
        match self.events.recv_timeout(timeout) {
            Ok(item) => self.settle(item).map(Some),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => self.closed(None).map(Some),
        }
    }

    /// Consume events until [`SessionEvent::Idle`] with no subagents running.
    /// An [`SessionEvent::Ended`] on the way fails with a downcastable [`SessionEnded`].
    /// `Idle { subagents_running: true }` is consumed and the wait continues — the session
    /// will auto-continue once the forks complete.
    pub fn wait_until_idle(&mut self) -> Result<()> {
        loop {
            match self.next_event()? {
                SessionEvent::Idle { subagents_running: false } => return Ok(()),
                SessionEvent::Ended => {
                    return Err(anyhow::Error::new(SessionEnded)
                        .context("the session ended while waiting for idle"));
                }
                _ => {}
            }
        }
    }

    /// Escape hatch: write raw bytes straight into the session's PTY over the ptyd
    /// socket, bypassing the app's state tracking entirely. Prefer
    /// [`ClaudeSession::send_user_message`].
    pub fn send_raw_terminal_input(&self, bytes: &[u8]) -> Result<()> {
        let client = crate::connect_ptyd()?;
        crate::ensure_session_running(&client, &self.terminal_session_id)?;
        client.notify(RequestOp::Write {
            session_id: self.terminal_session_id.clone(),
            data: BASE64.encode(bytes),
        })?;
        Ok(())
    }

    fn settle(&mut self, item: StreamItem) -> Result<SessionEvent> {
        match item {
            StreamItem::Event(event) => {
                if event == SessionEvent::Ended {
                    self.ended = true;
                }
                Ok(event)
            }
            StreamItem::Closed(reason) => self.closed(reason),
        }
    }

    fn closed(&self, reason: Option<String>) -> Result<SessionEvent> {
        if self.ended {
            return Err(anyhow::Error::new(SessionEnded)
                .context("the event stream is over: the session ended"));
        }
        match reason {
            Some(reason) => bail!("the event stream failed: {reason}"),
            // A server-side close without Ended means the app went away or this
            // subscriber lagged and was dropped: resubscribe and catch up via the
            // transcript if continuity matters.
            None => bail!(
                "the event stream was lost (app shutdown or this subscriber lagged); \
                 resubscribe to continue"
            ),
        }
    }
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        // Releases the reader thread's blocking read (EOF) and tells the server this
        // subscriber is gone (its next write fails).
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

fn read_events(mut reader: BufReader<UnixStream>, tx: SyncSender<StreamItem>) {
    let mut line = String::new();
    loop {
        match reader.read_line(&mut line) {
            Ok(0) => {
                let _ = tx.send(StreamItem::Closed(None));
                return;
            }
            Ok(_) => {
                let parsed = serde_json::from_str::<RuntimeResponse>(&line);
                line.clear();
                match parsed {
                Ok(RuntimeResponse::Event { event, .. }) => {
                    let ended = event == SessionEvent::Ended;
                    if tx.send(StreamItem::Event(event)).is_err() {
                        return;
                    }
                    if ended {
                        // The server closes after Ended; treat the stream as complete
                        // without depending on observing the EOF first.
                        let _ = tx.send(StreamItem::Closed(None));
                        return;
                    }
                }
                // Heartbeats keep the connection observable server-side; nothing to
                // surface. A stray Ack is tolerated the same way.
                Ok(RuntimeResponse::Ping) | Ok(RuntimeResponse::Ack) => {}
                Ok(RuntimeResponse::Err { error, .. }) => {
                    let _ = tx.send(StreamItem::Closed(Some(error)));
                    return;
                }
                Ok(other) => {
                    let _ = tx.send(StreamItem::Closed(Some(format!(
                        "unexpected line on the event stream: {other:?}"
                    ))));
                    return;
                }
                Err(e) => {
                    let _ = tx.send(StreamItem::Closed(Some(format!(
                        "unparseable line on the event stream: {e}"
                    ))));
                    return;
                }
                }
            }
            // The connection-wide read timeout firing between heartbeats: keep reading.
            // `line` is NOT cleared — read_line resumes appending to a partial line.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => {
                let _ = tx.send(StreamItem::Closed(Some(e.to_string())));
                return;
            }
        }
    }
}
