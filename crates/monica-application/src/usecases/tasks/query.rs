use anyhow::Result;

use super::ports::{EventRepository, TaskRepository, TaskSummaryFilter};
use crate::{Event, Task, TaskSummaryRow};

pub fn list_tasks<R>(repos: &R) -> Result<Vec<Task>>
where
    R: TaskRepository,
{
    repos.list_tasks()
}

pub fn list_task_summaries<R>(
    repos: &R,
    filter: TaskSummaryFilter,
    project: Option<&str>,
) -> Result<Vec<TaskSummaryRow>>
where
    R: TaskRepository,
{
    repos.list_task_summaries(filter, project)
}

pub fn list_events<R>(repos: &R, task_id: Option<&str>) -> Result<Vec<Event>>
where
    R: EventRepository,
{
    repos.list_events(task_id)
}
