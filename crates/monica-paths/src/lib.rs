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

/// Shared per-agent shell scaffolding: `<base>/shell/<agent>/` (holds the wrapper bin).
/// The files are task-independent templates; task identity travels via env vars, so one copy
/// per agent serves every task and stays current with the running app version.
pub fn agent_shell_dir(agent: &str) -> Result<PathBuf> {
    Ok(base_dir()?.join("shell").join(agent))
}

/// The zdotdir every Monica-spawned zsh boots through: `<base>/shell/zdotdir/`. Shared across
/// agents — its `.zshenv` installs one wrapper function per agent, so any tab can launch any
/// supported agent wrapped.
pub fn shell_zdotdir() -> Result<PathBuf> {
    Ok(base_dir()?.join("shell").join("zdotdir"))
}

/// Unix domain socket the PTY daemon (`monica-ptyd`) listens on.
pub fn ptyd_socket_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("ptyd.sock"))
}

/// Pid/lock file guaranteeing a single daemon instance per base dir.
pub fn ptyd_pid_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("ptyd.pid"))
}

/// Bounded transcript files for terminal sessions: `<base>/terminal-sessions/<session_id>.log`.
pub fn terminal_sessions_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("terminal-sessions"))
}

/// Root for notebook page collections: `<base>/notebooks/`.
pub fn notebooks_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("notebooks"))
}

/// A single notebook's directory: `<base>/notebooks/<slug>/` (holds `step-*.md` pages).
pub fn notebook_dir(slug: &str) -> Result<PathBuf> {
    Ok(notebooks_dir()?.join(slug))
}
