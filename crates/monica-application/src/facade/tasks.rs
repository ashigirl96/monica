use super::{Backend, Monica};
use crate::usecases::tasks::{
    AttachSessionReport, CloseTaskReport, MakeMainOutcome, TabTaskBinding,
};
use crate::prelude::{Agent, DisplayStatus, Event, Task, TaskId, TaskRunStatus};
use crate::{ApplicationEvent, ApplicationResult, TaskSummaryRow};
use crate::ports::{TaskRunStore, TaskSummaryFilter};

/// Task lifecycle and task/run read models.
pub struct TaskService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> TaskService<'_, B> {
    pub fn create_raw_task(&mut self, title: &str, project_id: &str) -> ApplicationResult<Task> {
        crate::usecases::tasks::create_raw_task(&mut self.m.repos, title, project_id)
    }

    pub fn close_task(&mut self, id: &TaskId) -> ApplicationResult<CloseTaskReport> {
        let Monica { repos, git, .. } = &mut *self.m;
        crate::usecases::tasks::close_task(repos, git, id)
    }

    /// Connect the agent session running in a terminal tab to an existing task, as a run with no
    /// worktree and no branch that becomes the task's Main Run. `cwd` seeds the task's bench when it
    /// has none. Announces the new run and every run
    /// the tab was driving before (settled and unbound by the attach), so the board and the bench
    /// refresh when the caller is the desktop; the CLI's sink drops these events.
    pub fn attach_terminal_session(
        &mut self,
        task_id: &TaskId,
        agent: Agent,
        terminal_tab_id: &str,
        terminal_session_id: &str,
        cwd: &str,
    ) -> ApplicationResult<AttachSessionReport> {
        let Monica { repos, events, .. } = &mut *self.m;
        let report = crate::usecases::tasks::attach_terminal_session_to_task(
            repos,
            task_id,
            agent,
            terminal_tab_id,
            terminal_session_id,
            cwd,
        )?;
        // `detached_run_ids` carries no task or status; a detached run may also have been settled
        // long before this attach (a hook's SessionEnd, a failed setup), so read back what each
        // actually is rather than announcing a status it never reached.
        for run_id in &report.detached_run_ids {
            if let Some(run) = repos.get_task_run(run_id)? {
                events.emit(ApplicationEvent::TaskRunStatusChanged {
                    task_id: run.task_id.into(),
                    task_run_id: run.id.into(),
                    status: run.status,
                });
            }
        }
        events.emit(ApplicationEvent::TaskRunStatusChanged {
            task_id: report.task_id.to_string(),
            task_run_id: report.task_run_id.to_string(),
            status: TaskRunStatus::Running,
        });
        Ok(report)
    }

    /// Live tab-driven runs paired with their task's bench runspace, for the Workbench to pull
    /// each tab into the runspace it belongs to.
    pub fn list_tab_task_bindings(&self) -> ApplicationResult<Vec<TabTaskBinding>> {
        crate::usecases::tasks::list_tab_task_bindings(&self.m.repos)
    }

    /// Promote the run hosted in a Workbench tab to its task's Main Run, emitting the run's new
    /// status when the promotion actually changes the pointer. Returns whether the primary actually
    /// changed.
    pub fn make_main_by_terminal_tab(&mut self, terminal_tab_id: &str) -> ApplicationResult<bool> {
        let Monica { repos, events, .. } = &mut *self.m;
        let outcome = crate::usecases::tasks::make_main_by_terminal_tab(repos, terminal_tab_id)?;
        if let MakeMainOutcome::Changed { task_id, task_run_id, status } = &outcome {
            events.emit(ApplicationEvent::TaskRunStatusChanged {
                task_id: task_id.clone(),
                task_run_id: task_run_id.clone(),
                status: *status,
            });
        }
        Ok(matches!(outcome, MakeMainOutcome::Changed { .. }))
    }

    pub fn primary_terminal_tab(&self, task_id: &TaskId) -> ApplicationResult<Option<String>> {
        crate::usecases::tasks::primary_terminal_tab(&self.m.repos, task_id)
    }

    pub fn list_tasks(&self) -> ApplicationResult<Vec<Task>> {
        crate::usecases::query::list_tasks(&self.m.repos)
    }

    pub fn list_all_task_summaries(
        &self,
        project: Option<&str>,
    ) -> ApplicationResult<Vec<TaskSummaryRow>> {
        self.list_task_summaries(TaskSummaryFilter::All, project)
    }

    pub fn list_active_task_summaries(
        &self,
        project: Option<&str>,
    ) -> ApplicationResult<Vec<TaskSummaryRow>> {
        self.list_task_summaries(TaskSummaryFilter::Active, project)
    }

    pub fn list_task_summaries_by_status(
        &self,
        status: DisplayStatus,
        project: Option<&str>,
    ) -> ApplicationResult<Vec<TaskSummaryRow>> {
        self.list_task_summaries(TaskSummaryFilter::Status(status), project)
    }

    fn list_task_summaries(
        &self,
        filter: TaskSummaryFilter,
        project: Option<&str>,
    ) -> ApplicationResult<Vec<TaskSummaryRow>> {
        crate::usecases::query::list_task_summaries(&self.m.repos, filter, project)
    }

    pub fn list_events(&self, task_id: Option<&TaskId>) -> ApplicationResult<Vec<Event>> {
        crate::usecases::query::list_events(&self.m.repos, task_id)
    }

    pub fn plan_path_for_terminal_tab(&self, terminal_tab_id: &str) -> ApplicationResult<Option<String>> {
        crate::usecases::query::plan_path_for_terminal_tab(&self.m.repos, terminal_tab_id)
    }
}
