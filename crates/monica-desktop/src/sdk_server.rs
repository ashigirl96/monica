//! SDK control socket: the release-build entry for external Rust processes to drive Monica
//! (`monica-claude-sdk::open_session`). One NDJSON request/response pair per connection on
//! `<base>/sdk.sock` — the Rust-client counterpart of the browser-facing WebSocket planned
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
use monica_sdk_protocol::{
    SdkRequest, SdkRequestOp, SdkResponse, SdkSessionInfo, PROTOCOL_VERSION,
};
use tauri::{AppHandle, Manager};

use crate::commands::terminal::default_shell;
use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

const READ_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("monica-sdk-server".to_string())
        .spawn(move || {
            if let Err(e) = serve(&app) {
                log::error!(target: "monica_app::sdk", "sdk control socket failed: {e:#}");
            }
        });
    if let Err(e) = spawned {
        log::error!(target: "monica_app::sdk", "failed to start sdk server thread: {e}");
    }
}

fn serve(app: &AppHandle) -> Result<()> {
    let socket_path = monica_paths::sdk_socket_path()?;
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
        target: "monica_app::sdk",
        "sdk control socket listening on {}",
        socket_path.display()
    );
    // One thread per connection (the ptyd daemon's accept shape): a client that connects
    // and then stalls must not block other SDK clients from being served.
    let mut next_conn_id: u64 = 0;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                next_conn_id += 1;
                let app = app.clone();
                let spawned = std::thread::Builder::new()
                    .name(format!("monica-sdk-conn-{next_conn_id}"))
                    .spawn(move || {
                        if let Err(e) = serve_connection(&app, stream) {
                            log::warn!(target: "monica_app::sdk", "sdk connection failed: {e:#}");
                        }
                    });
                if let Err(e) = spawned {
                    log::error!(target: "monica_app::sdk", "failed to spawn sdk connection thread: {e}");
                }
            }
            Err(e) => log::warn!(target: "monica_app::sdk", "sdk accept failed: {e}"),
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

fn handle_line(app: &AppHandle, line: &str) -> SdkResponse {
    let op = match parse_request(line) {
        Ok(op) => op,
        Err(error) => return SdkResponse::Err { error },
    };
    let SdkRequestOp::OpenSdkSession { cwd, model, title, claude_session_id } = op;
    match open_sdk_session(app, cwd, model, title, claude_session_id) {
        Ok(session) => SdkResponse::Ok { session },
        Err(e) => SdkResponse::Err {
            error: format!("{e:#}"),
        },
    }
}

fn parse_request(line: &str) -> Result<SdkRequestOp, String> {
    let request: SdkRequest =
        serde_json::from_str(line).map_err(|e| format!("invalid request: {e}"))?;
    if request.version != PROTOCOL_VERSION {
        return Err(format!(
            "sdk protocol version mismatch: client={}, server={PROTOCOL_VERSION}",
            request.version
        ));
    }
    Ok(request.op)
}

fn open_sdk_session(
    app: &AppHandle,
    cwd: String,
    model: Option<String>,
    title: Option<String>,
    claude_session_id: Option<String>,
) -> Result<SdkSessionInfo> {
    let state = app.state::<PtydHandle>();
    let daemon = PtydTerminalDaemon { handle: state.inner(), app };
    let mut monica = event_sink::open(app).map_err(|e| anyhow::anyhow!(e.message))?;
    // The facade owns the whole transaction — spawn, acknowledged launch write, rollback
    // on failure, and the adoption event — so the response returning Ok means "claude
    // launch submitted". The connection runs on its own thread, so the shell-readiness
    // wait inside blocks nobody else.
    let spec = monica.executions().open_sdk_session(
        &daemon,
        monica_application::OpenSdkSessionParams {
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
    Ok(SdkSessionInfo {
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
        let line = r#"{"version":999,"op":"open_sdk_session","cwd":"/tmp"}"#;
        let error = parse_request(line).unwrap_err();
        assert!(error.contains("version mismatch"), "got: {error}");
    }

    #[test]
    fn rejects_a_v1_request_before_any_session_is_launched() {
        // v1 predates the claude_session_id idempotency contract. parse_request runs
        // before open_sdk_session, so this rejection is guaranteed side-effect free —
        // the same guarantee a v1 server gives a v2 client.
        let line = r#"{"version":1,"op":"open_sdk_session","cwd":"/tmp"}"#;
        let error = parse_request(line).unwrap_err();
        assert!(error.contains("version mismatch"), "got: {error}");
    }

    #[test]
    fn accepts_a_current_version_request() {
        let line =
            format!(r#"{{"version":{PROTOCOL_VERSION},"op":"open_sdk_session","cwd":"/tmp"}}"#);
        let op = parse_request(&line).unwrap();
        let SdkRequestOp::OpenSdkSession { cwd, model, title, claude_session_id } = op;
        assert_eq!(cwd, "/tmp");
        assert_eq!(model, None);
        assert_eq!(title, None);
        assert_eq!(claude_session_id, None);
    }
}
