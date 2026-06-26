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
    fn run_setup_script(
        &self,
        worktree: &Path,
        log_path: &Path,
        env: &SetupEnv,
        timeout: Duration,
    ) -> Result<SetupOutcome>;
}
