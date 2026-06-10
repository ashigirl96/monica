use anyhow::Result;

use crate::{NewTaskRun, TaskRun, TaskRunObservation, TaskRunStatus};

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
    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>>;
    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()>;
}
