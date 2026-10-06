//! The daemon side of tania-ptyd: a Unix-socket NDJSON server owning all PTY sessions.
//! It never touches SQLite — durable state is the app's job — so an old daemon binary can
//! keep serving sessions across app/schema upgrades without running migrations.

mod connection;
mod outbox;
mod state;

pub use state::SessionTable;

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

const SOCKET_CHECK_INTERVAL: Duration = Duration::from_secs(2);

pub struct DaemonConfig {
    pub socket_path: PathBuf,
    pub pid_path: PathBuf,
    pub sessions_dir: PathBuf,
}

/// Bind the socket and serve until told to shut down. Returns immediately (Ok) when
/// another daemon already holds the pid lock, so concurrent spawns collapse to one.
pub fn run_daemon(config: DaemonConfig) -> Result<()> {
    if let Some(parent) = config.pid_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut pid_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&config.pid_path)
        .with_context(|| format!("failed to open {}", config.pid_path.display()))?;
    if pid_file.try_lock().is_err() {
        log::info!("another tania-ptyd already holds the lock; exiting");
        return Ok(());
    }
    pid_file.set_len(0)?;
    writeln!(pid_file, "{}", std::process::id())?;
    pid_file.flush()?;

    // Safe to unlink: we hold the lock, so any socket file here is from a dead daemon.
    let _ = std::fs::remove_file(&config.socket_path);
    let listener = UnixListener::bind(&config.socket_path)
        .with_context(|| format!("failed to bind {}", config.socket_path.display()))?;
    log::info!(
        "tania-ptyd listening on {} (pid {})",
        config.socket_path.display(),
        std::process::id()
    );
    let bound = file_identity(&config.socket_path)
        .with_context(|| format!("failed to stat {}", config.socket_path.display()))?;
    let socket_path = config.socket_path.clone();
    std::thread::Builder::new()
        .name("ptyd-socket-watch".into())
        .spawn(move || exit_when_socket_goes_away(&socket_path, bound))
        .context("failed to spawn socket watch thread")?;

    let table = Arc::new(SessionTable::new(config.sessions_dir));
    let mut next_conn_id: u64 = 0;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                next_conn_id += 1;
                let conn_id = next_conn_id;
                let table = Arc::clone(&table);
                let spawned = std::thread::Builder::new()
                    .name(format!("ptyd-conn-{conn_id}"))
                    .spawn(move || connection::serve_connection(stream, table, conn_id));
                if let Err(e) = spawned {
                    log::error!("failed to spawn connection thread: {e}");
                }
            }
            Err(e) => log::warn!("accept failed: {e}"),
        }
    }
    drop(pid_file);
    Ok(())
}

fn exit_when_socket_goes_away(socket_path: &Path, bound: (u64, u64)) {
    loop {
        std::thread::sleep(SOCKET_CHECK_INTERVAL);
        if file_identity(socket_path).ok() != Some(bound) {
            log::info!(
                "{} is gone or no longer ours; exiting",
                socket_path.display()
            );
            std::process::exit(0);
        }
    }
}

fn file_identity(path: &Path) -> std::io::Result<(u64, u64)> {
    std::fs::metadata(path).map(|m| (m.dev(), m.ino()))
}
