use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::prelude::Project;
use crate::ExecutionProfile;

pub trait TaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf>;
    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf>;
    /// Prepare the task-specific pieces — the identity env vars the task shell must be spawned
    /// with, plus any per-worktree agent config. The agent scaffolding itself is layered on at
    /// terminal-session creation (`ShellScaffolding::prepare_base_shell_env`).
    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        project: &Project,
        profile: &ExecutionProfile,
        task_run_id: Option<&str>,
        cwd: &Path,
    ) -> Result<Vec<(String, String)>>;
}
