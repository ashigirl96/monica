use std::path::{Path, PathBuf};

use anyhow::Result;

use monica_domain::Agent;

use crate::prelude::Project;
use crate::ExecutionProfile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskShellEnv {
    pub env: Vec<(String, String)>,
    pub settings_path: String,
    pub wrapper_path: String,
}

pub trait TaskRunOutputs {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf>;
    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf>;
    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        project: &Project,
        profile: &ExecutionProfile,
        task_run_id: Option<&str>,
        cwd: &Path,
    ) -> Result<TaskShellEnv>;
    fn append_hook_event(
        &self,
        task_run_id: &str,
        at: &str,
        event_label: Option<&str>,
        raw_stdin: &str,
    ) -> Result<()>;
    /// Register the agent's hook callbacks in `cwd`'s settings file (merge-only for
    /// Claude, keeping other keys). Returns the settings path. The hook set is the single
    /// shared one — a task shell and a Claude Runtime session in the same cwd must not
    /// fight over the `hooks` key with diverging sets.
    fn install_agent_hooks(&self, agent: Agent, cwd: &Path) -> Result<String>;
}
