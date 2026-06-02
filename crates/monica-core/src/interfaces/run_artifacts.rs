use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::Value;

use crate::{AgentLaunch, Project};

use super::AgentLaunchMode;

pub trait RunArtifacts {
    fn task_run_dir(&self, task_run_id: &str) -> Result<PathBuf>;
    fn setup_log_path(&self, task_run_id: &str) -> Result<PathBuf>;
    fn write_reused_worktree_setup_log(&self, task_run_id: &str) -> Result<String>;
    fn prepare_claude_launch(
        &self,
        task_run_id: &str,
        task_id: &str,
        project: &Project,
        worktree: &Path,
        launch_mode: &AgentLaunchMode,
    ) -> Result<(AgentLaunch, String)>;
    fn append_hook_event(
        &self,
        task_run_id: &str,
        at: &str,
        event_name: Option<&str>,
        parsed: &Option<Value>,
        raw_stdin: &str,
    ) -> Result<()>;
}
