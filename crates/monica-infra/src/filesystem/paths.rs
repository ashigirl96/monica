use std::path::PathBuf;

use anyhow::{anyhow, Result};

const HOME_SUBDIR: &str = "monica";

/// Resolve Monica's base directory: `$MONICA_HOME` when set, otherwise `$HOME/monica`.
pub fn base_dir() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("MONICA_HOME") {
        return Ok(PathBuf::from(home));
    }
    let home =
        std::env::var_os("HOME").ok_or_else(|| anyhow!("neither MONICA_HOME nor HOME is set"))?;
    Ok(PathBuf::from(home).join(HOME_SUBDIR))
}

pub fn db_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("db").join("monica.db"))
}

pub fn task_runs_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("runs"))
}

pub fn logs_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("logs"))
}

/// Per-task-run output directory: `<base>/runs/<task_run_id>/` (holds `setup.log`, later session output).
pub fn task_run_dir(task_run_id: &str) -> Result<PathBuf> {
    Ok(task_runs_dir()?.join(task_run_id))
}

/// Per-task shell output directory: `<base>/tasks/<task_id>/` (holds wrapper, settings, zdotdir).
pub fn task_shell_dir(task_id: &str) -> Result<PathBuf> {
    Ok(base_dir()?.join("tasks").join(task_id))
}

/// Unix domain socket the PTY daemon (`monica-ptyd`) listens on.
pub fn ptyd_socket_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("ptyd.sock"))
}

/// Pid/lock file guaranteeing a single daemon instance per base dir.
pub fn ptyd_pid_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("ptyd.pid"))
}

/// Per-entry attachment directory: `<base>/attachments/<entry_id>/`.
pub fn attachments_dir(entry_id: &str) -> Result<PathBuf> {
    Ok(base_dir()?.join("attachments").join(entry_id))
}

/// Bounded transcript files for terminal sessions: `<base>/terminal-sessions/<session_id>.log`.
pub fn terminal_sessions_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("terminal-sessions"))
}
