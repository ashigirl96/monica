use anyhow::Result;

use crate::prelude::{NewTaskRun, TaskRun, TaskRunStatus};
use crate::TaskRunObservation;

pub trait TaskRunStore {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun>;
    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()>;
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
    /// Lazily create a run for a session-starting hook in one transaction: inserts the run and,
    /// when `make_primary_if_missing`, points the task's primary at it. Folding both writes into a
    /// single transaction keeps a hook arriving from a separate process from stranding a run with
    /// no primary pointer — the intermediate state a two-call (`start_task_run` then
    /// `set_primary_task_run`) sequence could leave behind.
    fn create_lazy_run_for_session(
        &mut self,
        new: NewTaskRun,
        make_primary_if_missing: bool,
    ) -> Result<TaskRun>;
    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()>;
}
