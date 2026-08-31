use std::path::PathBuf;

use anyhow::Result;

use monica_domain::{TaskId, TaskRunId};

use crate::prelude::Project;

pub trait TaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &TaskRunId) -> Result<PathBuf>;
    fn setup_log_path(&self, task_run_id: &TaskRunId) -> Result<PathBuf>;
    /// Prepare the task-specific pieces — the identity env vars the task shell must be spawned
    /// with. The agent scaffolding itself is layered on at terminal-session creation
    /// (`ShellScaffolding::prepare_base_shell_env`).
    fn prepare_task_shell_env(
        &self,
        task_id: &TaskId,
        project: &Project,
        task_run_id: Option<&TaskRunId>,
    ) -> Result<Vec<(String, String)>>;
}
