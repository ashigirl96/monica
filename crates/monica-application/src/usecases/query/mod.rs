mod ports;

use self::ports::{
    EventRepository, ProjectRepository, TaskBoardQuery, TaskRunStore, TaskStore, TaskSummaryFilter,
};
use crate::prelude::{Event, Project, Task};
use crate::{ApplicationError, ApplicationResult, TaskSummaryRow};

/// The plan file path retained on the run currently driven by the given Workbench tab — set when
/// that run surfaced a plan via `ExitPlanMode`. `None` for a shell tab, a run that never planned,
/// or an unknown tab.
pub fn plan_path_for_terminal_tab<R>(repos: &R, terminal_tab_id: &str) -> ApplicationResult<Option<String>>
where
    R: TaskRunStore,
{
    Ok(repos
        .find_task_run_by_terminal_tab(terminal_tab_id)?
        .and_then(|run| run.plan_file_path))
}

pub fn list_tasks<R>(repos: &R) -> ApplicationResult<Vec<Task>>
where
    R: TaskStore,
{
    Ok(repos.list_tasks()?)
}

pub fn task_memo<R>(repos: &R, task_id: &str) -> ApplicationResult<String>
where
    R: TaskStore,
{
    Ok(repos.task_memo(task_id)?)
}

pub fn update_task_memo<R>(repos: &R, task_id: &str, memo: &str) -> ApplicationResult<()>
where
    R: TaskStore,
{
    Ok(repos.update_task_memo(task_id, memo)?)
}

pub fn list_task_summaries<R>(
    repos: &R,
    filter: TaskSummaryFilter,
    project: Option<&str>,
) -> ApplicationResult<Vec<TaskSummaryRow>>
where
    R: TaskBoardQuery,
{
    Ok(repos.list_task_summaries(filter, project)?)
}

pub fn list_projects<R>(repos: &R) -> ApplicationResult<Vec<Project>>
where
    R: ProjectRepository,
{
    Ok(repos.list_projects()?)
}

pub fn get_project<R>(repos: &R, repo: &str) -> ApplicationResult<Project>
where
    R: ProjectRepository,
{
    repos
        .get_project(repo)?
        .ok_or_else(|| ApplicationError::not_found(format!("project not found: {repo}")))
}

pub fn set_project_field<R>(repos: &R, repo: &str, key: &str, value: &str) -> ApplicationResult<()>
where
    R: ProjectRepository,
{
    Ok(repos.set_project_field(repo, key, value)?)
}

pub fn list_events<R>(repos: &R, task_id: Option<&str>) -> ApplicationResult<Vec<Event>>
where
    R: EventRepository,
{
    Ok(repos.list_events(task_id)?)
}
