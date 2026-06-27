use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SetupOutcome {
    Skipped,
    ReusedWorktree,
    Succeeded,
    Failed { code: Option<i32>, timed_out: bool },
}

impl SetupOutcome {
    pub fn is_failure(&self) -> bool {
        matches!(self, SetupOutcome::Failed { .. })
    }
}

pub struct SetupEnv {
    pub monica_id: String,
    pub task_run_id: String,
    pub project_id: String,
    pub branch: String,
    pub worktree: String,
}

pub trait SetupRunner {
    /// `Ok(SetupOutcome::Failed { .. })` is a script that ran but exited non-zero or timed out — a
    /// normal run outcome. `Err` is reserved for failing to *run* the script at all (spawn/IO
    /// fault), which the caller surfaces as an `External` error rather than a merely-failed run.
    fn run_setup_script(
        &self,
        worktree: &Path,
        log_path: &Path,
        env: &SetupEnv,
        timeout: Duration,
    ) -> Result<SetupOutcome>;
}
