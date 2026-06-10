//! The daemon side of monica-ptyd: a Unix-socket NDJSON server owning all PTY sessions.
//! It never touches SQLite — durable state is the app's job — so an old daemon binary can
//! keep serving sessions across app/schema upgrades without running migrations.

mod connection;
mod state;

pub use state::SessionTable;

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};

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
        log::info!("another monica-ptyd already holds the lock; exiting");
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
        "monica-ptyd listening on {} (pid {})",
        config.socket_path.display(),
        std::process::id()
    );

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
