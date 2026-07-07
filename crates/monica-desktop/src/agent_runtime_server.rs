//! Agent Runtime control socket: the release-build entry for external Rust processes to drive Monica
//! (`monica-claude-sdk::open_session`). One NDJSON request/response pair per connection on
//! `<base>/agent-runtime.sock` — the Rust-client counterpart of the browser-facing WebSocket planned
//! for MVP7.
//!
//! Trust boundary: the socket is 0600, so only processes running as this user can connect —
//! the same model as `ptyd.sock` next to it, which already grants strictly more power (raw
//! PTY writes into any session). A same-uid token would add nothing (the token file would be
//! readable by the same uid); browser clients get a token- and Origin-gated WebSocket in MVP7.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use anyhow::{Context, Result};
use monica_agent_runtime_protocol::{
    RuntimeRequest, RuntimeRequestOp, RuntimeResponse, ClaudeSessionInfo, PROTOCOL_VERSION,
};
use tauri::{AppHandle, Manager};

use crate::commands::terminal::default_shell;
use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

const READ_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

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
    let response = handle_line(app, &line);
    let mut payload = serde_json::to_string(&response)?;
    payload.push('\n');
    let mut stream = stream;
    stream.write_all(payload.as_bytes())?;
    Ok(())
}

fn handle_line(app: &AppHandle, line: &str) -> RuntimeResponse {
    let op = match parse_request(line) {
        Ok(op) => op,
        Err(error) => return RuntimeResponse::Err { error, indeterminate: false },
    };
    let RuntimeRequestOp::OpenClaudeSession { cwd, model, title, claude_session_id } = op;
    match open_claude_session(app, cwd, model, title, claude_session_id) {
        Ok(session) => RuntimeResponse::Ok { session },
        Err(e) => error_response(&e),
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
    RuntimeResponse::Err { error: format!("{e:#}"), indeterminate }
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
    let RuntimeRequestOp::OpenClaudeSession { claude_session_id, .. } = &request.op;
    if claude_session_id.is_none() {
        return Err(
            "open_claude_session requires claude_session_id (the client-minted idempotency \
             key): mint a UUID, send it with the request, and reuse the same id when \
             retrying after an unknown outcome"
                .to_string(),
        );
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
    let jsonl_path = std::env::var_os("HOME").map(|home| {
        monica_application::claude_jsonl_path(
            std::path::Path::new(&home),
            &spec.cwd,
            &spec.claude_session_id,
        )
        .to_string_lossy()
        .into_owned()
    });
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
        let RuntimeResponse::Err { indeterminate, error } = error_response(&e) else {
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
        let RuntimeRequestOp::OpenClaudeSession { cwd, model, title, claude_session_id } = op;
        assert_eq!(cwd, "/tmp");
        assert_eq!(model, None);
        assert_eq!(title, None);
        assert_eq!(
            claude_session_id.as_deref(),
            Some("5e0f5b0e-9f5c-4a4e-9d6e-000000000000")
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
