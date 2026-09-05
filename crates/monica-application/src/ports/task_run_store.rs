use anyhow::Result;

use monica_domain::{AgentSessionId, TaskId, TaskRunId};

use crate::prelude::{Agent, NewTaskRun, TaskRun, TaskRunStatus};
use crate::TaskRunObservation;

/// Outcome of binding a terminal tab to a task with [`TaskRunStore::attach_terminal_tab_to_task`].
pub struct TabAttachment {
    pub run: TaskRun,
    /// Runs this tab was driving until now. Each was settled if still live, then had its
    /// `terminal_tab_id` cleared: every path that stops a run keys on that tab, so an un-settled
    /// run losing it would never reach a terminal status again. `agent_session_id` is deliberately
    /// left behind as the record of which agent session discussed that task.
    pub detached_run_ids: Vec<TaskRunId>,
}

pub trait TaskRunStore {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun>;
    fn finish_task_run(
        &mut self,
        task_run_id: &TaskRunId,
        task_id: &TaskId,
        status: TaskRunStatus,
    ) -> Result<()>;
    fn set_task_run_worktree_path(&self, task_run_id: &TaskRunId, worktree_path: &str) -> Result<()>;
    /// Record the agent a launch actually used, so a later resume reopens the session under the
    /// same agent even when it was an override of the profile default.
    fn set_task_run_agent(&self, task_run_id: &TaskRunId, agent: Agent) -> Result<()>;
    fn get_task_run(&self, id: &TaskRunId) -> Result<Option<TaskRun>>;
    fn find_task_run_by_session(
        &self,
        task_id: &TaskId,
        agent_session_id: &AgentSessionId,
    ) -> Result<Option<TaskRun>>;
    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>>;
    fn list_task_runs_for_task(&self, task_id: &TaskId) -> Result<Vec<TaskRun>>;
    /// Runs still pinned to a terminal tab and not yet in a terminal state — the candidate set for
    /// the orphaned-run settlement sweep.
    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>>;
    /// Settle a still-live run as stopped, returning `true` only if this call moved it (a hook may
    /// have settled it first, in which case the caller must not re-announce).
    fn settle_task_run_if_live(&mut self, task_run_id: &TaskRunId, task_id: &TaskId) -> Result<bool>;
    /// Atomically claim a still-`prepared` run for a session: stamps `agent_session_id` only if
    /// the run is still `prepared` and unclaimed, in a single guarded UPDATE. Returns `true` iff
    /// this call won the claim — closing the concurrent-SessionStart race that a snapshot read
    /// (SELECT then UPDATE) cannot. `last_event_at` is left to the observation that follows.
    fn claim_prepared_run(
        &self,
        task_run_id: &TaskRunId,
        agent_session_id: &AgentSessionId,
    ) -> Result<bool>;
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
    /// Bind a terminal tab, and the agent session running inside it, to a task as a fresh
    /// `running` run — the durable half of `monica task attach`. Settling and unbinding the runs
    /// this tab previously drove happens in the same transaction as the insert, so the tab -> run
    /// lookup can never observe two candidates and no run is stranded live with no tab left to
    /// settle it. The task's primary pointer is left to the use case, which decides whether the
    /// attached run may take the Main Run slot.
    fn attach_terminal_tab_to_task(
        &mut self,
        new: NewTaskRun,
        terminal_tab_id: &str,
        agent_session_id: Option<&AgentSessionId>,
    ) -> Result<TabAttachment>;
    fn record_task_run_observation(
        &mut self,
        task_run_id: &TaskRunId,
        observation: TaskRunObservation<'_>,
    ) -> Result<()>;
}
