use anyhow::{anyhow, Result};

use crate::interfaces::{EventRepository, ProjectRepository, TaskRepository};
use crate::{DisplayStatus, Event, Project, Task, TaskStatus, TaskSummaryRow};

pub fn list_tasks<R>(repos: &R) -> Result<Vec<Task>>
where
    R: TaskRepository,
{
    repos.list_tasks()
}

pub fn list_task_summaries<R>(
    repos: &R,
    status: Option<DisplayStatus>,
    project: Option<&str>,
) -> Result<Vec<TaskSummaryRow>>
where
    R: TaskRepository,
{
    repos.list_task_summaries(status, project)
}

pub fn mark_issue<R>(repos: &mut R, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()>
where
    R: TaskRepository,
{
    repos.mark_task(id, status, note)
}

pub fn list_projects<R>(repos: &R) -> Result<Vec<Project>>
where
    R: ProjectRepository,
{
    repos.list_projects()
}

pub fn get_project<R>(repos: &R, repo: &str) -> Result<Project>
where
    R: ProjectRepository,
{
    repos
        .get_project(repo)?
        .ok_or_else(|| anyhow!("project not found: {repo}"))
}

pub fn set_project_field<R>(repos: &R, repo: &str, key: &str, value: &str) -> Result<()>
where
    R: ProjectRepository,
{
    repos.set_project_field(repo, key, value)
}

pub fn list_events<R>(repos: &R, task_id: Option<&str>) -> Result<Vec<Event>>
where
    R: EventRepository,
{
    repos.list_events(task_id)
}
