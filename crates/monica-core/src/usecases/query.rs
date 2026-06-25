use anyhow::{anyhow, Result};

use crate::interfaces::{
    EventRepository, ProjectRepository, TaskRepository, TaskRunRepository, TaskSummaryFilter,
};
use crate::{Event, Project, Task, TaskSummaryRow};

/// The plan file path retained on the run currently driven by the given Workbench tab — set when
/// that run surfaced a plan via `ExitPlanMode`. `None` for a shell tab, a run that never planned,
/// or an unknown tab.
pub fn plan_path_for_terminal_tab<R>(repos: &R, terminal_tab_id: &str) -> Result<Option<String>>
where
    R: TaskRunRepository,
{
    Ok(repos
        .find_task_run_by_terminal_tab(terminal_tab_id)?
        .and_then(|run| run.plan_file_path))
}

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
