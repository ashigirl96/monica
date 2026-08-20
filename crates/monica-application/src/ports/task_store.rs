use anyhow::Result;

use crate::prelude::{ExternalReference, Task, TaskStatus};
use crate::prelude::NewTask;

/// Task aggregate persistence: create, read, status transitions, primary-run pointer, and the
/// external references attached at creation. Board summaries ([`TaskBoardQuery`]) and pull-request
/// sync ([`PullRequestSyncStore`]) are deliberately separate ports so consumers depend only on what
/// they use.
pub trait TaskStore {
    fn insert_task(&mut self, new: NewTask) -> Result<Task>;
    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalReference) -> Result<Task>;
    fn get_task(&self, id: &str) -> Result<Option<Task>>;
    fn mark_task_closed(&mut self, id: &str) -> Result<Task>;
    fn list_tasks(&self) -> Result<Vec<Task>>;
    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()>;
    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()>;
    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()>;
    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalReference>>;
}
