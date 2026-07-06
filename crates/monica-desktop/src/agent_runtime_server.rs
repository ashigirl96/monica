//! Agent Runtime control socket: the release-build entry for external Rust processes to drive Monica
//! (`monica-claude-sdk`). NDJSON on `<base>/agent-runtime.sock` — one request/response pair per
//! connection, except `subscribe`, which holds its connection open and streams event lines. The
//! Rust-client counterpart of the browser-facing WebSocket planned for MVP7.
//!
//! Trust boundary: the socket is 0600, so only processes running as this user can connect —
//! the same model as `ptyd.sock` next to it, which already grants strictly more power (raw
//! PTY writes into any session). A same-uid token would add nothing (the token file would be
//! readable by the same uid); browser clients get a token- and Origin-gated WebSocket in MVP7.
//! One resident thread per subscription is accepted under the same boundary.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use monica_agent_runtime_protocol::{
    ClaudeSessionInfo, ClaudeSessionSummary, RuntimeErrorCode, RuntimeRequest, RuntimeRequestOp,
    RuntimeResponse, SessionEvent, PROTOCOL_VERSION,
};
use tauri::{AppHandle, Manager};

use crate::agent_runtime_events::ClaudeSessionBroadcaster;
use crate::commands::terminal::default_shell;
use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

const READ_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Idle interval after which a subscription writes a `ping`. The write is the liveness
/// probe: it fails (EPIPE / write timeout) once the client is gone, which is the only
/// way this thread learns about a disconnect — it never reads after the request line.
const SUBSCRIBE_HEARTBEAT: Duration = Duration::from_secs(15);

pub(crate) fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("monica-agent-runtime-server".to_string())
        .spawn(move || {
            if let Err(e) = serve(&app) {
                log::error!(target: "monica_app::agent_runtime", "agent runtime control socket failed: {e:#}");
            }
        });
    if let Err(e) = spawned {
        log::error!(target: "monica_app::agent_runtime", "failed to start agent runtime server thread: {e}");
    }
}

fn serve(app: &AppHandle) -> Result<()> {
    let socket_path = monica_paths::agent_runtime_socket_path()?;
    // A fresh MONICA_HOME has no base dir yet, and nothing else is guaranteed to have
    // created it before this thread binds.
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    // Safe to unlink: dev/prod instances point at different MONICA_HOME base dirs, so any
    // file here is a leftover of a previous run of this same instance.
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("failed to bind {}", socket_path.display()))?;
    // Owner-only, explicitly rather than inherited from the umask (see the trust-boundary
    // note in the module doc).
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to restrict {}", socket_path.display()))?;
    log::info!(
        target: "monica_app::agent_runtime",
        "agent runtime control socket listening on {}",
        socket_path.display()
    );
    // One thread per connection (the ptyd daemon's accept shape): a client that connects
    // and then stalls must not block other Agent Runtime clients from being served.
    let mut next_conn_id: u64 = 0;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                next_conn_id += 1;
                let app = app.clone();
                let spawned = std::thread::Builder::new()
                    .name(format!("monica-agent-runtime-conn-{next_conn_id}"))
                    .spawn(move || {
                        if let Err(e) = serve_connection(&app, stream) {
                            log::warn!(target: "monica_app::agent_runtime", "agent runtime connection failed: {e:#}");
                        }
                    });
                if let Err(e) = spawned {
                    log::error!(target: "monica_app::agent_runtime", "failed to spawn agent runtime connection thread: {e}");
                }
            }
            Err(e) => log::warn!(target: "monica_app::agent_runtime", "agent runtime accept failed: {e}"),
        }
    }
    Ok(())
}

fn serve_connection(app: &AppHandle, stream: UnixStream) -> Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    match parse_request(&line) {
        Ok(RuntimeRequestOp::Subscribe { claude_session_id }) => {
            serve_subscription(app, &stream, &claude_session_id)
        }
        Ok(op) => write_line(&stream, &handle_op(app, op)),
        Err(error) => {
            write_line(&stream, &RuntimeResponse::Err { error, indeterminate: false, code: None })
        }
    }
}

fn write_line(mut stream: &UnixStream, response: &RuntimeResponse) -> Result<()> {
    let mut payload = serde_json::to_string(response)?;
    payload.push('\n');
    stream.write_all(payload.as_bytes())?;
    Ok(())
}

fn handle_op(app: &AppHandle, op: RuntimeRequestOp) -> RuntimeResponse {
    match op {
        RuntimeRequestOp::OpenClaudeSession { cwd, model, title, claude_session_id } => {
            match open_claude_session(app, cwd, model, title, claude_session_id) {
                Ok(session) => RuntimeResponse::Ok { session },
                Err(e) => error_response(&e),
            }
        }
        RuntimeRequestOp::SendUserMessage { claude_session_id, text } => {
            run_session_op(app, |monica, daemon| {
                monica.executions().send_claude_user_message(daemon, &claude_session_id, &text)?;
                Ok(RuntimeResponse::Ack)
            })
        }
        RuntimeRequestOp::InterruptSession { claude_session_id } => {
            run_session_op(app, |monica, daemon| {
                monica.executions().interrupt_claude_session(daemon, &claude_session_id)?;
                Ok(RuntimeResponse::Ack)
            })
        }
        RuntimeRequestOp::ListSessions => run_session_op(app, |monica, daemon| {
            let sessions = monica.executions().list_claude_sessions(daemon)?;
            Ok(RuntimeResponse::Sessions {
                sessions: sessions.into_iter().map(summary_from).collect(),
            })
        }),
        RuntimeRequestOp::SyncTerminalSession { terminal_session_id } => {
            run_session_op(app, |monica, daemon| {
                monica.executions().sync_terminal_session(daemon, &terminal_session_id)?;
                Ok(RuntimeResponse::Ack)
            })
        }
        RuntimeRequestOp::Subscribe { .. } => unreachable!("dispatched in serve_connection"),
    }
}

/// Common prelude for the session-driving ops: daemon + façade, then the op, with its
/// [`monica_application::ApplicationError`] classified into a wire code.
fn run_session_op(
    app: &AppHandle,
    op: impl FnOnce(
        &mut event_sink::AppMonica,
        &PtydTerminalDaemon<'_>,
    ) -> Result<RuntimeResponse, monica_application::ApplicationError>,
) -> RuntimeResponse {
    let state = app.state::<PtydHandle>();
    let daemon = PtydTerminalDaemon { handle: state.inner(), app };
    let mut monica = match event_sink::open(app) {
        Ok(monica) => monica,
        Err(e) => {
            return RuntimeResponse::Err { error: e.message, indeterminate: false, code: None }
        }
    };
    match op(&mut monica, &daemon) {
        Ok(response) => response,
        Err(e) => session_error_response(&e),
    }
}

/// Wire classification for the session-driving ops. `Validation → SessionEnded` is sound
/// for exactly these ops: their only validation failure is "the session has ended" (the
/// open op keeps its own uncoded mapping, where validation means bad input).
fn session_error_response(e: &monica_application::ApplicationError) -> RuntimeResponse {
    use monica_application::ApplicationError;
    let code = match e {
        ApplicationError::Conflict(_) => Some(RuntimeErrorCode::Busy),
        ApplicationError::NotFound(_) => Some(RuntimeErrorCode::NotFound),
        ApplicationError::Validation(_) => Some(RuntimeErrorCode::SessionEnded),
        _ => None,
    };
    RuntimeResponse::Err {
        error: e.to_string(),
        indeterminate: matches!(e, ApplicationError::Indeterminate(_)),
        code,
    }
}

fn summary_from(row: monica_domain::ClaudeSession) -> ClaudeSessionSummary {
    ClaudeSessionSummary {
        claude_session_id: row.claude_session_id,
        tab_id: row.tab_id,
        terminal_session_id: row.terminal_session_id,
        cwd: row.cwd,
        name: row.name,
        session_status: row.status.as_str().to_string(),
        conversation_status: row.conversation_status.as_str().to_string(),
        wait_reason: row.wait_reason.map(|r| r.as_str().to_string()),
        created_at: row.created_at,
        ended_at: row.ended_at,
    }
}

/// The state a subscription reports before any live event arrives, as a pure wire
/// translation: the readiness judgment (which `idle` may be trusted) lives in
/// [`monica_domain::ClaudeSession::observed_conversation_status`]. `Thinking` maps to no
/// snapshot — the stream only reports settled states.
fn snapshot_event(row: &monica_domain::ClaudeSession) -> Option<SessionEvent> {
    if row.status == monica_domain::ClaudeSessionStatus::Ended {
        return Some(SessionEvent::Ended);
    }
    match row.observed_conversation_status()? {
        monica_domain::ClaudeConversationStatus::Idle => Some(SessionEvent::Idle),
        monica_domain::ClaudeConversationStatus::AwaitingUser => {
            Some(SessionEvent::AwaitingUser {
                wait_reason: row.wait_reason.map(|r| r.as_str().to_string()),
            })
        }
        monica_domain::ClaudeConversationStatus::Thinking => None,
    }
}

fn serve_subscription(
    app: &AppHandle,
    stream: &UnixStream,
    claude_session_id: &str,
) -> Result<()> {
    let broadcaster = app.state::<Arc<ClaudeSessionBroadcaster>>();
    // Registered BEFORE the snapshot read: an event landing between the two is delivered
    // twice (snapshot + live), never lost. Duplicates are defined harmless. The RAII
    // subscription unregisters on every exit path below.
    let subscription = broadcaster.inner().subscribe(claude_session_id);
    let row = {
        let state = app.state::<PtydHandle>();
        let daemon = PtydTerminalDaemon { handle: state.inner(), app };
        let mut monica = event_sink::open(app).map_err(|e| anyhow::anyhow!(e.message))?;
        let sessions = monica.executions().list_claude_sessions(&daemon)?;
        sessions.into_iter().find(|s| s.claude_session_id == claude_session_id)
    };
    let Some(row) = row else {
        return write_line(
            stream,
            &RuntimeResponse::Err {
                error: format!("claude session {claude_session_id} not found"),
                indeterminate: false,
                code: Some(RuntimeErrorCode::NotFound),
            },
        );
    };
    write_line(stream, &RuntimeResponse::Ack)?;
    if let Some(event) = snapshot_event(&row) {
        let ended = event == SessionEvent::Ended;
        write_line(
            stream,
            &RuntimeResponse::Event { claude_session_id: claude_session_id.to_string(), event },
        )?;
        if ended {
            return Ok(());
        }
    }
    loop {
        match subscription.recv_timeout(SUBSCRIBE_HEARTBEAT) {
            Ok(event) => {
                let ended = event == SessionEvent::Ended;
                write_line(
                    stream,
                    &RuntimeResponse::Event {
                        claude_session_id: claude_session_id.to_string(),
                        event,
                    },
                )?;
                if ended {
                    return Ok(());
                }
            }
            Err(RecvTimeoutError::Timeout) => write_line(stream, &RuntimeResponse::Ping)?,
            // The broadcaster dropped this subscriber (its buffer filled): close the
            // stream so the client sees an explicit end instead of a silent gap.
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

/// An outcome the application itself could not determine (an unconfirmed launch
/// reservation, an unverifiable daemon) must reach the client marked as such: a
/// determinate `Err` licenses a fresh-id retry, which against an unresolved open would
/// duplicate the session.
fn error_response(e: &anyhow::Error) -> RuntimeResponse {
    let indeterminate = matches!(
        e.downcast_ref::<monica_application::ApplicationError>(),
        Some(monica_application::ApplicationError::Indeterminate(_))
    );
    RuntimeResponse::Err { error: format!("{e:#}"), indeterminate, code: None }
}

fn parse_request(line: &str) -> Result<RuntimeRequestOp, String> {
    let request: RuntimeRequest =
        serde_json::from_str(line).map_err(|e| format!("invalid request: {e}"))?;
    if request.version != PROTOCOL_VERSION {
        return Err(format!(
            "agent runtime protocol version mismatch: client={}, server={PROTOCOL_VERSION}",
            request.version
        ));
    }
    // The key is what makes an indeterminate failure recoverable: a server-minted id
    // would live only in the lost response, so a client without one has nothing
    // structured to retry with and would duplicate the session on a fresh open.
    if let RuntimeRequestOp::OpenClaudeSession { claude_session_id, .. } = &request.op {
        if claude_session_id.is_none() {
            return Err(
                "open_claude_session requires claude_session_id (the client-minted idempotency \
                 key): mint a UUID, send it with the request, and reuse the same id when \
                 retrying after an unknown outcome"
                    .to_string(),
            );
        }
    }
    Ok(request.op)
}

fn open_claude_session(
    app: &AppHandle,
    cwd: String,
    model: Option<String>,
    title: Option<String>,
    claude_session_id: Option<String>,
) -> Result<ClaudeSessionInfo> {
    let state = app.state::<PtydHandle>();
    let daemon = PtydTerminalDaemon { handle: state.inner(), app };
    let mut monica = event_sink::open(app).map_err(|e| anyhow::anyhow!(e.message))?;
    // The facade owns the whole transaction — spawn, acknowledged launch write, rollback
    // on failure, and the adoption event — so the response returning Ok means "claude
    // launch submitted". The connection runs on its own thread, so the shell-readiness
    // wait inside blocks nobody else.
    let spec = monica.executions().open_claude_session(
        &daemon,
        monica_application::OpenClaudeSessionParams {
            cwd,
            model,
            title,
            shell: default_shell(),
            claude_session_id,
        },
    )?;
    let home = std::env::var_os("HOME")
        .ok_or_else(|| anyhow::anyhow!("HOME is not set; cannot resolve the transcript path"))?;
    let jsonl_path = monica_application::claude_jsonl_path(
        std::path::Path::new(&home),
        &spec.cwd,
        &spec.claude_session_id,
    )
    .to_string_lossy()
    .into_owned();
    Ok(ClaudeSessionInfo {
        runspace_id: spec.runspace_id,
        tab_id: spec.tab_id,
        session_id: spec.session_id,
        claude_session_id: spec.claude_session_id,
        cwd: spec.cwd,
        initial_command: spec.initial_command,
        title: spec.title,
        jsonl_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_json() {
        let error = parse_request("not json").unwrap_err();
        assert!(error.contains("invalid request"), "got: {error}");
    }

    #[test]
    fn rejects_a_version_mismatch() {
        let line = r#"{"version":999,"op":"open_claude_session","cwd":"/tmp"}"#;
        let error = parse_request(line).unwrap_err();
        assert!(error.contains("version mismatch"), "got: {error}");
    }

    #[test]
    fn rejects_a_v1_request_before_any_session_is_launched() {
        // v1 predates the claude_session_id idempotency contract. parse_request runs
        // before open_claude_session, so this rejection is guaranteed side-effect free —
        // the same guarantee a v1 server gives a v2 client.
        let line = r#"{"version":1,"op":"open_claude_session","cwd":"/tmp"}"#;
        let error = parse_request(line).unwrap_err();
        assert!(error.contains("version mismatch"), "got: {error}");
    }

    #[test]
    fn indeterminate_application_errors_are_marked_on_the_wire() {
        let e = anyhow::Error::new(monica_application::ApplicationError::indeterminate(
            "unconfirmed launch",
        ));
        let RuntimeResponse::Err { indeterminate, error, .. } = error_response(&e) else {
            panic!("expected an error response");
        };
        assert!(indeterminate);
        assert!(error.contains("unconfirmed launch"), "got: {error}");
    }

    #[test]
    fn determinate_application_errors_stay_determinate_on_the_wire() {
        let e = anyhow::Error::new(monica_application::ApplicationError::validation("bad cwd"));
        let RuntimeResponse::Err { indeterminate, .. } = error_response(&e) else {
            panic!("expected an error response");
        };
        assert!(!indeterminate);
    }

    #[test]
    fn accepts_a_current_version_request() {
        let line = format!(
            r#"{{"version":{PROTOCOL_VERSION},"op":"open_claude_session","cwd":"/tmp",
                "claude_session_id":"5e0f5b0e-9f5c-4a4e-9d6e-000000000000"}}"#
        );
        let op = parse_request(&line).unwrap();
        let RuntimeRequestOp::OpenClaudeSession { cwd, model, title, claude_session_id } = op
        else {
            panic!("expected open_claude_session");
        };
        assert_eq!(cwd, "/tmp");
        assert_eq!(model, None);
        assert_eq!(title, None);
        assert_eq!(
            claude_session_id.as_deref(),
            Some("5e0f5b0e-9f5c-4a4e-9d6e-000000000000")
        );
    }

    #[test]
    fn accepts_the_session_driving_ops() {
        let send = format!(
            r#"{{"version":{PROTOCOL_VERSION},"op":"send_user_message","claude_session_id":"u-1","text":"hi"}}"#
        );
        assert!(matches!(
            parse_request(&send).unwrap(),
            RuntimeRequestOp::SendUserMessage { .. }
        ));
        let interrupt = format!(
            r#"{{"version":{PROTOCOL_VERSION},"op":"interrupt_session","claude_session_id":"u-1"}}"#
        );
        assert!(matches!(
            parse_request(&interrupt).unwrap(),
            RuntimeRequestOp::InterruptSession { .. }
        ));
        let list = format!(r#"{{"version":{PROTOCOL_VERSION},"op":"list_sessions"}}"#);
        assert!(matches!(parse_request(&list).unwrap(), RuntimeRequestOp::ListSessions));
        let subscribe = format!(
            r#"{{"version":{PROTOCOL_VERSION},"op":"subscribe","claude_session_id":"u-1"}}"#
        );
        assert!(matches!(
            parse_request(&subscribe).unwrap(),
            RuntimeRequestOp::Subscribe { .. }
        ));
        let sync = format!(
            r#"{{"version":{PROTOCOL_VERSION},"op":"sync_terminal_session","terminal_session_id":"ts-1"}}"#
        );
        assert!(matches!(
            parse_request(&sync).unwrap(),
            RuntimeRequestOp::SyncTerminalSession { .. }
        ));
    }

    #[test]
    fn session_errors_are_classified_into_wire_codes() {
        use monica_application::ApplicationError;
        let cases = [
            (ApplicationError::conflict("busy"), Some(RuntimeErrorCode::Busy)),
            (ApplicationError::not_found("nope"), Some(RuntimeErrorCode::NotFound)),
            (ApplicationError::validation("ended"), Some(RuntimeErrorCode::SessionEnded)),
            (ApplicationError::external("io"), None),
        ];
        for (error, expected) in cases {
            let RuntimeResponse::Err { code, .. } = session_error_response(&error) else {
                panic!("expected an error response");
            };
            assert_eq!(code, expected);
        }
        let RuntimeResponse::Err { indeterminate, .. } =
            session_error_response(&monica_application::ApplicationError::indeterminate("?"))
        else {
            panic!("expected an error response");
        };
        assert!(indeterminate);
    }

    fn subscription_row(
        status: monica_domain::ClaudeSessionStatus,
        conversation_status: monica_domain::ClaudeConversationStatus,
        provider_session_id: Option<&str>,
    ) -> monica_domain::ClaudeSession {
        monica_domain::ClaudeSession {
            claude_session_id: "u-1".into(),
            runspace_id: "agent-runtime".into(),
            tab_id: "tab-1".into(),
            terminal_session_id: "ts-1".into(),
            cwd: "/tmp".into(),
            name: None,
            status,
            launch_phase: monica_domain::ClaudeLaunchPhase::Submitting,
            conversation_status,
            wait_reason: None,
            provider_session_id: provider_session_id.map(str::to_string),
            jsonl_offset: 0,
            created_at: "2026-07-06T00:00:00Z".into(),
            ended_at: None,
        }
    }

    #[test]
    fn snapshot_reports_only_hook_observed_states() {
        use monica_domain::{ClaudeConversationStatus as C, ClaudeSessionStatus as S};
        // The column-default idle of a booting session must not leak as a snapshot.
        assert_eq!(snapshot_event(&subscription_row(S::Active, C::Idle, None)), None);
        assert_eq!(
            snapshot_event(&subscription_row(S::Active, C::Idle, Some("s-1"))),
            Some(SessionEvent::Idle)
        );
        assert_eq!(snapshot_event(&subscription_row(S::Active, C::Thinking, Some("s-1"))), None);
        assert_eq!(
            snapshot_event(&subscription_row(S::Active, C::AwaitingUser, Some("s-1"))),
            Some(SessionEvent::AwaitingUser { wait_reason: None })
        );
        assert_eq!(
            snapshot_event(&subscription_row(S::Ended, C::Idle, None)),
            Some(SessionEvent::Ended)
        );
    }

    #[test]
    fn rejects_a_request_without_the_idempotency_key_before_any_side_effect() {
        // Without a client-held key an indeterminate failure is unrecoverable (the
        // server's mint would exist only in the lost response), so the request is
        // refused at parse time — before open_claude_session can create anything.
        let line =
            format!(r#"{{"version":{PROTOCOL_VERSION},"op":"open_claude_session","cwd":"/tmp"}}"#);
        let error = parse_request(&line).unwrap_err();
        assert!(error.contains("requires claude_session_id"), "got: {error}");
    }
}
