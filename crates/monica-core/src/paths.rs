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

/// Per-task-run artifact directory: `<base>/runs/<task_run_id>/` (holds `setup.log`, later session output).
pub fn task_run_dir(task_run_id: &str) -> Result<PathBuf> {
    Ok(task_runs_dir()?.join(task_run_id))
}

/// Legacy shared worktree root under Monica's base dir. New `issue run` callers should prefer a
/// project-local default (`<project.path>/.worktrees`) and use this only when they explicitly want
/// a Monica-managed shared location.
pub fn worktrees_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("worktrees"))
}

/// Serializes tests that mutate process-global `MONICA_HOME` / `HOME`. Cargo runs tests in
/// threads within one process, so without this they race. Poisoning is ignored: a panic in one
/// env test must not cascade-fail the others.
#[cfg(test)]
pub(crate) fn test_env_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
