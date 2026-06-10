use std::path::PathBuf;

use anyhow::Result;
use serde_json::Value;

use crate::Project;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskShellEnv {
    pub env: Vec<(String, String)>,
    pub settings_path: String,
    pub wrapper_path: String,
}

pub trait RunArtifacts {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf>;
    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf>;
    fn prepare_task_shell_env(
        &self,
        task_id: &str,
        project: &Project,
        task_run_id: Option<&str>,
    ) -> Result<TaskShellEnv>;
    fn append_hook_event(
        &self,
        task_run_id: &str,
        at: &str,
        event_name: Option<&str>,
        parsed: &Option<Value>,
        raw_stdin: &str,
    ) -> Result<()>;
}
