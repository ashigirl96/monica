use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{NewTaskRun, Project, TaskRun, TaskRunObservation, TaskRunStatus};

pub use crate::usecases::projects::ports::ProjectRepository;
pub use crate::usecases::tasks::ports::{EventRepository, TaskRepository};

pub trait TaskRunRepository {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun>;
    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()>;
    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()>;
    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()>;
    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>>;
    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>>;
    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>>;
    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>>;
    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()>;
}

pub trait BenchRepository {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>>;
    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>>;
    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()>;
    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()>;
}

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
        task_run_id: Option<&str>,
        cwd: &Path,
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

pub trait GitGateway {
    fn create_worktree(&self, repo: &Path, worktree: &Path, branch: &str, base: &str)
        -> Result<()>;
    fn cleanup_task_runs(&self, repo: &Path, runs: &[TaskRun]) -> Result<Vec<String>>;
    fn detect_repo(&self) -> Result<String>;
    fn detect_default_branch(&self, repo: &str) -> Option<String>;
}

pub trait Clock {
    fn now_iso(&self) -> Result<String>;
}
