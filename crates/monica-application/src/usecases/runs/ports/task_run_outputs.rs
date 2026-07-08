use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::prelude::Project;
use crate::ExecutionProfile;

pub trait TaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf>;
    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf>;
    /// Prepare the shell scaffolding (wrapper, zdotdir, hooks config) and return the env vars the
    /// task shell must be spawned with.
    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        project: &Project,
        profile: &ExecutionProfile,
        task_run_id: Option<&str>,
        cwd: &Path,
    ) -> Result<Vec<(String, String)>>;
    fn append_hook_event(
        &self,
        task_run_id: &str,
        at: &str,
        event_label: Option<&str>,
        raw_stdin: &str,
    ) -> Result<()>;
}
