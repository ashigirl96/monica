use super::{Backend, Monica};
use crate::usecases::tasks::{CloseIssueReport, MakeMainOutcome};
use crate::prelude::{DisplayStatus, Event, Task};
use crate::{ApplicationEvent, ApplicationResult, TaskSummaryRow};
use crate::ports::TaskSummaryFilter;

/// Task lifecycle and task/run read models.
pub struct TaskService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> TaskService<'_, B> {
    pub fn create_raw_task(&mut self, title: &str, project_id: &str) -> ApplicationResult<Task> {
        crate::usecases::tasks::create_raw_task(&mut self.m.repos, title, project_id)
    }

    pub fn close_issue(&mut self, id: &str) -> ApplicationResult<CloseIssueReport> {
        let Monica { repos, git, .. } = &mut *self.m;
        crate::usecases::tasks::close_issue(repos, git, id)
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

    pub fn primary_terminal_tab(&self, task_id: &str) -> ApplicationResult<Option<String>> {
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

    pub fn task_memo(&self, task_id: &str) -> ApplicationResult<String> {
        crate::usecases::query::task_memo(&self.m.repos, task_id)
    }

    pub fn update_task_memo(&self, task_id: &str, memo: &str) -> ApplicationResult<()> {
        crate::usecases::query::update_task_memo(&self.m.repos, task_id, memo)
    }

    pub fn list_events(&self, task_id: Option<&str>) -> ApplicationResult<Vec<Event>> {
        crate::usecases::query::list_events(&self.m.repos, task_id)
    }

    pub fn plan_path_for_terminal_tab(&self, terminal_tab_id: &str) -> ApplicationResult<Option<String>> {
        crate::usecases::query::plan_path_for_terminal_tab(&self.m.repos, terminal_tab_id)
    }
}
