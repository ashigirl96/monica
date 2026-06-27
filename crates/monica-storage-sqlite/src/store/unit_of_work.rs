use anyhow::Result;
use rusqlite::Transaction;

use crate::SqliteStore;
use monica_application::{
    Clock, Event, EventRepository, ExternalReference, NewTask, NewTaskRun, Task, TaskRun,
    TaskRunObservation, TaskRunStatus, TaskRunStore, TaskStatus, TaskStore, UnitOfWork,
    WorkTransaction, WorkbenchStore,
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
    fn begin(&mut self) -> Result<Box<dyn WorkTransaction + '_>> {
        Ok(Box::new(SqliteUow { tx: self.conn_mut().transaction()? }))
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

    fn get_task(&self, id: &str) -> Result<Option<Task>> {
        tasks::get_task(&self.tx, id)
    }

    fn mark_task_closed(&mut self, id: &str) -> Result<Task> {
        tasks::mark_task_closed_in(&self.tx, id)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        tasks::list_tasks(&self.tx)
    }

    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()> {
        tasks::set_primary_task_run(&self.tx, task_id, task_run_id)
    }

    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()> {
        tasks::update_task_status(&self.tx, id, status)
    }

    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()> {
        tasks::mark_task_in(&self.tx, id, status, note)
    }

    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalReference>> {
        external_refs::list_external_refs(&self.tx, task_id)
    }
}

impl TaskRunStore for SqliteUow<'_> {
    fn start_task_run(&mut self, new: NewTaskRun) -> Result<TaskRun> {
        task_runs::start_task_run_in(&self.tx, new)
    }

    fn finish_task_run(
        &mut self,
        task_run_id: &str,
        task_id: &str,
        status: TaskRunStatus,
    ) -> Result<()> {
        task_runs::finish_task_run_in(&self.tx, task_run_id, task_id, status)
    }

    fn set_task_run_settings_path(&self, task_run_id: &str, settings_path: &str) -> Result<()> {
        task_runs::set_task_run_settings_path(&self.tx, task_run_id, settings_path)
    }

    fn set_task_run_worktree_path(&self, task_run_id: &str, worktree_path: &str) -> Result<()> {
        task_runs::set_task_run_worktree_path(&self.tx, task_run_id, worktree_path)
    }

    fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        task_runs::get_task_run(&self.tx, id)
    }

    fn find_task_run_by_session(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<Option<TaskRun>> {
        task_runs::find_task_run_by_session(&self.tx, task_id, provider_session_id)
    }

    fn find_task_run_by_terminal_tab(&self, terminal_tab_id: &str) -> Result<Option<TaskRun>> {
        task_runs::find_task_run_by_terminal_tab(&self.tx, terminal_tab_id)
    }

    fn list_task_runs_for_task(&self, task_id: &str) -> Result<Vec<TaskRun>> {
        task_runs::list_task_runs_for_task(&self.tx, task_id)
    }

    fn list_driven_task_runs_with_tab(&self) -> Result<Vec<TaskRun>> {
        task_runs::list_driven_task_runs_with_tab(&self.tx)
    }

    fn settle_task_run_if_live(&mut self, task_run_id: &str, task_id: &str) -> Result<bool> {
        task_runs::settle_task_run_if_live_in(&self.tx, task_run_id, task_id)
    }

    fn claim_prepared_run(&self, task_run_id: &str, provider_session_id: &str) -> Result<bool> {
        task_runs::claim_prepared_run(&self.tx, task_run_id, provider_session_id)
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

    fn record_task_run_observation(
        &mut self,
        task_run_id: &str,
        observation: TaskRunObservation<'_>,
    ) -> Result<()> {
        task_runs::record_task_run_observation_in(&self.tx, task_run_id, observation)
    }
}

impl EventRepository for SqliteUow<'_> {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        events::insert_event_in(&self.tx, task_id, task_run_id, kind, payload_json)
    }

    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>> {
        events::list_events_in(&self.tx, task_id)
    }
}

impl Clock for SqliteUow<'_> {
    fn now_iso(&self) -> Result<String> {
        events::now_iso_in(&self.tx)
    }
}

impl WorkbenchStore for SqliteUow<'_> {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        bench::get_bench_for_task(&self.tx, task_id)
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        bench::list_bench_runspace_map(&self.tx)
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        bench::create_bench(&self.tx, task_id, runspace_id, cwd)
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        bench::update_bench_cwd(&self.tx, task_id, cwd)
    }
}
