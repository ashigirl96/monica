use anyhow::Result;

use crate::{NewTaskRun, TaskRun, TaskRunObservation, TaskRunStatus};

pub trait TaskRunStore {
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
    /// Runs still pinned to a terminal tab and not yet in a terminal state — the candidate set for
    /// the orphaned-run settlement sweep.
    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>>;
    /// Settle a still-live run as stopped, returning `true` only if this call moved it (a hook may
    /// have settled it first, in which case the caller must not re-announce).
    fn settle_task_run_if_live(&mut self, task_run_id: &str, task_id: &str) -> Result<bool>;
    /// Atomically claim a still-`prepared` run for a session: stamps `provider_session_id` only if
    /// the run is still `prepared` and unclaimed, in a single guarded UPDATE. Returns `true` iff
    /// this call won the claim — closing the concurrent-SessionStart race that a snapshot read
    /// (SELECT then UPDATE) cannot. `last_event_at` is left to the observation that follows.
    fn claim_prepared_run(&self, task_run_id: &str, provider_session_id: &str) -> Result<bool>;
    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()>;
}
