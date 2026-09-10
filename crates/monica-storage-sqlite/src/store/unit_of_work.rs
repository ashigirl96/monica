use anyhow::Result;
use rusqlite::{Transaction, TransactionBehavior};

use crate::SqliteStore;
use monica_application::{
    Clock, EventRepository, TabAttachment, TaskRunObservation, TaskRunStore, TaskStore, UnitOfWork,
    WorkTransaction, WorkbenchStore,
};
use monica_domain::{
    AgentSessionId, Event, ExternalReference, NewTask, NewTaskRun, Provider, RefType, RunspaceId,
    Task, TaskId, TaskRun, TaskRunId, TaskRunStatus, TaskStatus,
};

use super::{bench, events, external_refs, task_runs, tasks};

/// A [`WorkTransaction`] backed by one SQLite `Transaction`. Every store method runs on the shared
/// transaction via the same `*_in` helpers the direct [`SqliteStore`] uses, so the two paths can't
/// drift. Nothing is durable until [`WorkTransaction::commit`]; dropping without committing rolls
/// back (rusqlite's `Transaction` default).
struct SqliteUow<'conn> {
    tx: Transaction<'conn>,
}

impl UnitOfWork for SqliteStore {
    /// Takes the write lock up front. Use cases read state inside the transaction to decide what
    /// to write (is the Main Run slot free?), and a deferred transaction would let two processes
    /// both pass that read before either one's write is visible to the other.
    fn begin(&mut self) -> Result<Box<dyn WorkTransaction + '_>> {
        let tx = self.conn_mut().transaction_with_behavior(TransactionBehavior::Immediate)?;
        Ok(Box::new(SqliteUow { tx }))
    }
}

impl WorkTransaction for SqliteUow<'_> {
    fn commit(self: Box<Self>) -> Result<()> {
        self.tx.commit()?;
        Ok(())
    }
}

impl TaskStore for SqliteUow<'_> {
    fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        tasks::insert_task_in(&self.tx, new, None)
    }

    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalReference) -> Result<Task> {
        tasks::insert_task_in(&self.tx, new, Some(external))
    }

    fn get_task(&self, id: &TaskId) -> Result<Option<Task>> {
        tasks::get_task(&self.tx, id)
    }

    fn mark_task_closed(&mut self, id: &TaskId) -> Result<Task> {
        tasks::mark_task_closed_in(&self.tx, id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        tasks::list_tasks(&self.tx)
    }

    fn set_primary_task_run(&self, task_id: &TaskId, task_run_id: &TaskRunId) -> Result<()> {
        tasks::set_primary_task_run(&self.tx, task_id, task_run_id)
    }

    fn update_task_status(&self, id: &TaskId, status: TaskStatus) -> Result<()> {
        tasks::update_task_status(&self.tx, id, status)
    }

    fn mark_task(&mut self, id: &TaskId, status: TaskStatus, note: Option<&str>) -> Result<()> {
        tasks::mark_task_in(&self.tx, id, status, note)
    }

    fn list_external_refs(&self, task_id: &TaskId) -> Result<Vec<ExternalReference>> {
        external_refs::list_external_refs(&self.tx, task_id)
    }

    fn find_open_task_by_external_ref(
        &self,
        provider: Provider,
        ref_type: RefType,
        repo: &str,
        number: i64,
    ) -> Result<Option<Task>> {
        tasks::find_open_task_by_external_ref_in(&self.tx, provider, ref_type, repo, number)
    }
}

impl TaskRunStore for SqliteUow<'_> {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        task_runs::start_task_run_in(&self.tx, new)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &TaskRunId,
        task_id: &TaskId,
        status: TaskRunStatus,
    ) -> Result<()> {
        task_runs::finish_task_run_in(&self.tx, task_run_id, task_id, status)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &TaskRunId, worktree_path: &str) -> Result<()> {
        task_runs::set_task_run_worktree_path(&self.tx, task_run_id, worktree_path)
    }

    fn set_task_run_agent(&self, task_run_id: &TaskRunId, agent: monica_domain::Agent) -> Result<()> {
        task_runs::set_task_run_agent(&self.tx, task_run_id, agent)
    }

    fn get_task_run(&self, id: &TaskRunId) -> Result<Option<TaskRun>> {
        task_runs::get_task_run(&self.tx, id)
    }

    fn find_task_run_by_session(
        &self,
        task_id: &TaskId,
        agent_session_id: &AgentSessionId,
    ) -> Result<Option<TaskRun>> {
        task_runs::find_task_run_by_session(&self.tx, task_id, agent_session_id)
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        task_runs::find_task_run_by_terminal_tab(&self.tx, terminal_tab_id)
    }

    fn list_task_runs_for_task(&self, task_id: &TaskId) -> Result<Vec<TaskRun>> {
        task_runs::list_task_runs_for_task(&self.tx, task_id)
    }

    fn list_worktree_paths(&self) -> Result<Vec<String>> {
        task_runs::list_worktree_paths(&self.tx)
    }

    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>> {
        task_runs::list_driven_task_runs_with_tab(&self.tx)
    }

    fn is_task_run_older_than(&self, task_run_id: &TaskRunId, max_age_secs: i64) -> Result<bool> {
        task_runs::is_task_run_older_than(&self.tx, task_run_id, max_age_secs)
    }

    fn settle_task_run_if_live(&mut self, task_run_id: &TaskRunId, task_id: &TaskId) -> Result<bool> {
        task_runs::settle_task_run_if_live_in(&self.tx, task_run_id, task_id)
    }

    fn claim_prepared_run(
        &self,
        task_run_id: &TaskRunId,
        agent_session_id: &AgentSessionId,
    ) -> Result<bool> {
        task_runs::claim_prepared_run(&self.tx, task_run_id, agent_session_id)
    }

    fn create_lazy_run_for_session(
        &mut self,
        new: NewTaskRun,
        make_primary_if_missing: bool,
    ) -> Result<TaskRun> {
        let task_id = new.task_id.clone();
        let run = task_runs::start_task_run_in(&self.tx, new)?;
        if make_primary_if_missing {
            tasks::set_primary_task_run(&self.tx, &task_id, &run.id)?;
        }
        Ok(run)
    }

    fn attach_terminal_tab_to_task(
        &mut self,
        new: NewTaskRun,
        terminal_tab_id: &str,
        agent_session_id: Option<&AgentSessionId>,
    ) -> Result<TabAttachment> {
        task_runs::attach_terminal_tab_to_task_in(&self.tx, new, terminal_tab_id, agent_session_id)
    }

    fn record_task_run_observation(
        &mut self,
        task_run_id: &TaskRunId,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        task_runs::record_task_run_observation_in(&self.tx, task_run_id, observation)
    }
}

impl EventRepository for SqliteUow<'_> {
    fn insert_event(
        &self,
        task_id: Option<&TaskId>,
        task_run_id: Option<&TaskRunId>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        events::insert_event_in(&self.tx, task_id, task_run_id, kind, payload_json)
    }

    fn list_events(&self, task_id: Option<&TaskId>) -> Result<Vec<Event>> {
        events::list_events_in(&self.tx, task_id)
    }
}

impl Clock for SqliteUow<'_> {
    fn now_iso(&self) -> Result<String> {
        events::now_iso_in(&self.tx)
    }
}

impl WorkbenchStore for SqliteUow<'_> {
    fn get_bench_for_task(&self, task_id: &TaskId) -> Result<Option<(RunspaceId, String)>> {
        bench::get_bench_for_task(&self.tx, task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(RunspaceId, TaskId)>> {
        bench::list_bench_runspace_map(&self.tx)
    }

    fn create_bench(
        &mut self,
        task_id: &TaskId,
        runspace_id: &RunspaceId,
        cwd: &str,
    ) -> Result<()> {
        bench::create_bench(&self.tx, task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &TaskId, cwd: &str) -> Result<()> {
        bench::update_bench_cwd(&self.tx, task_id, cwd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::test_support::temp_db_path;
    use rusqlite::{Connection, ErrorCode};

    #[test]
    fn begin_holds_the_write_lock_before_any_write() {
        let path = temp_db_path("uow-lock");
        let mut store = SqliteStore::open_at(&path).unwrap();
        let other = Connection::open(&path).unwrap();
        other.busy_timeout(std::time::Duration::ZERO).unwrap();

        let tx = store.begin().unwrap();
        let err = other
            .execute_batch("BEGIN IMMEDIATE")
            .expect_err("a second writer must be refused while the unit of work is open");
        assert_eq!(
            err.sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy),
            "unexpected error: {err}"
        );
        drop(tx);

        other.execute_batch("BEGIN IMMEDIATE; ROLLBACK").unwrap();
    }
}
