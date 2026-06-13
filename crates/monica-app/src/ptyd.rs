//! Connection management for the PTY daemon: one persistent client shared by all terminal
//! commands, lazily (re)connected, spawning `monica-ptyd` on demand. Daemon events are
//! forwarded to the webview here, and exits are recorded into SQLite — the app is the only
//! writer of `terminal_sessions`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use monica_core::{TerminalSessionStatus, TerminalSessionUpdate};
use monica_infra::filesystem::paths;
use monica_infra::Runtime;
use monica_pty::client::{ClientEvent, PtydClient};
use monica_pty::protocol::{RequestOp, PROTOCOL_VERSION};
use tauri::{AppHandle, Emitter, Manager};

use crate::services::run_settlement;

const CONNECT_RETRY_WINDOW: Duration = Duration::from_secs(2);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(50);

pub struct PtydHandle {
    client: Mutex<Option<Arc<PtydClient>>>,
}

impl PtydHandle {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Option<Arc<PtydClient>>> {
        self.client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn current(&self) -> Option<Arc<PtydClient>> {
        self.guard().clone()
    }

    fn mark_disconnected(&self) {
        *self.guard() = None;
    }

    /// Reuse the live connection or establish one, spawning the daemon when absent and
    /// replacing it when it speaks an incompatible protocol.
    pub fn ensure_connected(&self, app: &AppHandle) -> Result<Arc<PtydClient>> {
        let mut guard = self.guard();
        if let Some(client) = guard.as_ref() {
            return Ok(Arc::clone(client));
        }
        let client = connect_or_spawn(app)?;
        let version = client.hello().context("daemon handshake failed")?;
        let client = if version == PROTOCOL_VERSION {
            client
        } else {
            replace_incompatible_daemon(app, &client, version)?
        };
        *guard = Some(Arc::clone(&client));
        Ok(client)
    }
}

fn connect_or_spawn(app: &AppHandle) -> Result<Arc<PtydClient>> {
    let socket = paths::ptyd_socket_path()?;
    if let Ok(client) = try_connect(app, &socket) {
        return Ok(client);
    }
    spawn_daemon()?;
    wait_for_connect(app, &socket).context("monica-ptyd did not come up after spawn")
}

fn wait_for_connect(app: &AppHandle, socket: &Path) -> Result<Arc<PtydClient>> {
    let deadline = Instant::now() + CONNECT_RETRY_WINDOW;
    loop {
        match try_connect(app, socket) {
            Ok(client) => return Ok(client),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => std::thread::sleep(CONNECT_RETRY_INTERVAL),
        }
    }
}

fn try_connect(app: &AppHandle, socket: &Path) -> Result<Arc<PtydClient>> {
    let app = app.clone();
    let client = PtydClient::connect(socket, move |event| handle_event(&app, event))?;
    Ok(Arc::new(client))
}

fn handle_event(app: &AppHandle, event: ClientEvent) {
    match event {
        ClientEvent::Output { session_id, data } => {
            let _ = app.emit(&format!("terminal:output:{session_id}"), &data);
        }
        ClientEvent::Exit {
            session_id,
            exit_code,
        } => {
            match Runtime::open_default() {
                Ok(mut runtime) => {
                    match runtime.repositories.update_terminal_session_status(
                        &session_id,
                        TerminalSessionStatus::Exited,
                        exit_code,
                    ) {
                        Ok(()) => run_settlement::settle_runs_for_terminated_sessions(
                            app,
                            &mut runtime,
                            std::slice::from_ref(&session_id),
                        ),
                        Err(e) => log::error!(
                            target: "monica_app::ptyd",
                            "failed to record exit of {session_id}: {e:#}"
                        ),
                    }
                }
                Err(e) => log::error!(
                    target: "monica_app::ptyd",
                    "failed to open runtime for exit of {session_id}: {e:#}"
                ),
            }
            let _ = app.emit(&format!("terminal:exit:{session_id}"), &exit_code);
            // Reap must be a notification: this runs on the client reader thread, and a
            // request() would deadlock waiting for a response only this thread can read.
            if let Some(client) = app.state::<PtydHandle>().current() {
                let _ = client.notify(RequestOp::Reap { session_id });
            }
        }
        ClientEvent::Disconnected => {
            log::warn!(target: "monica_app::ptyd", "monica-ptyd connection lost");
            app.state::<PtydHandle>().mark_disconnected();
        }
    }
}

fn replace_incompatible_daemon(
    app: &AppHandle,
    old: &Arc<PtydClient>,
    daemon_version: u32,
) -> Result<Arc<PtydClient>> {
    log::warn!(
        target: "monica_app::ptyd",
        "monica-ptyd speaks protocol {daemon_version} (want {PROTOCOL_VERSION}); replacing it"
    );
    // Honest-lost policy: the old daemon's sessions cannot be carried across the protocol
    // break, so settle them as lost before the restart kills their processes.
    match Runtime::open_default() {
        Ok(mut runtime) => {
            let updates: Vec<TerminalSessionUpdate> = runtime
                .repositories
                .list_terminal_sessions(None)
                .unwrap_or_default()
                .iter()
                .filter(|row| !row.status.is_terminal())
                .map(|row| TerminalSessionUpdate {
                    session_id: row.id.clone(),
                    status: TerminalSessionStatus::Lost,
                    pid: None,
                    exit_code: None,
                })
                .collect();
            match runtime.repositories.apply_terminal_session_updates(&updates) {
                Ok(()) => {
                    run_settlement::settle_runs_for_terminated_sessions(
                        app,
                        &mut runtime,
                        &run_settlement::terminated_session_ids(&updates),
                    );
                }
                Err(e) => {
                    log::error!(target: "monica_app::ptyd", "failed to mark sessions lost: {e:#}")
                }
            }
        }
        Err(e) => log::error!(target: "monica_app::ptyd", "failed to open runtime: {e:#}"),
    }

    let _ = old.notify(RequestOp::Shutdown);
    std::thread::sleep(Duration::from_millis(300));
    kill_daemon_from_pid_file();

    spawn_daemon()?;
    let socket = paths::ptyd_socket_path()?;
    let client = wait_for_connect(app, &socket)
        .context("replacement monica-ptyd did not come up")?;
    let version = client.hello()?;
    if version != PROTOCOL_VERSION {
        bail!("monica-ptyd still speaks protocol {version} after restart");
    }
    Ok(client)
}

/// Best-effort SIGTERM for a daemon too old to understand Shutdown.
fn kill_daemon_from_pid_file() {
    let Ok(pid_path) = paths::ptyd_pid_path() else {
        return;
    };
    let Ok(contents) = std::fs::read_to_string(&pid_path) else {
        return;
    };
    let Ok(pid) = contents.trim().parse::<u32>() else {
        return;
    };
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
}

fn ptyd_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("MONICA_PTYD_PATH") {
        return PathBuf::from(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri externalBin lands next to the app binary (Contents/MacOS/).
            let bundled = dir.join("monica-ptyd");
            if bundled.exists() {
                return bundled;
            }
        }
    }
    PathBuf::from("monica-ptyd")
}

// Warm up the daemon connection (and its event pump) off-thread so window startup never
// blocks on a daemon spawn. Reconciliation is NOT done here: the frontend's first
// terminal_list_sessions call owns it, after this connection (or its own) is up.
pub(crate) fn start_warmup(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("monica-ptyd-warmup".to_string())
        .spawn(move || {
            if let Err(e) = app.state::<PtydHandle>().ensure_connected(&app) {
                log::warn!(target: "monica_app::ptyd", "daemon warmup failed: {e:#}");
            }
        });
    if let Err(e) = spawned {
        log::error!(target: "monica_app::ptyd", "failed to start ptyd warmup thread: {e}");
    }
}

fn spawn_daemon() -> Result<()> {
    let base = paths::base_dir()?;
    let binary = ptyd_binary();
    let mut child = Command::new(&binary)
        .arg("--monica-home")
        .arg(&base)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn {}", binary.display()))?;
    // A pid-locked duplicate exits immediately; wait off-thread so it never zombies.
    std::thread::Builder::new()
        .name("ptyd-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .context("failed to spawn ptyd reaper thread")?;
    Ok(())
}
