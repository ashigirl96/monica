use std::path::Path;

use super::ports::{GitGateway, ProjectRepository, TaskRunStore, TaskStore};
use crate::prelude::{Task, TaskRun};
use crate::{ApplicationError, ApplicationResult};

#[derive(Debug, Clone, PartialEq)]
pub struct CloseIssueReport {
    pub item: Task,
    pub task_runs: Vec<String>,
    pub removed_branches: Vec<String>,
}

pub fn close_issue<R, G>(repos: &mut R, git: &G, id: &str) -> ApplicationResult<CloseIssueReport>
where
    R: TaskStore + TaskRunStore + ProjectRepository,
    G: GitGateway,
{
    let item = repos
        .get_task(id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {id}")))?;
    let runs = repos.list_task_runs_for_task(id)?;
    let removed_branches = cleanup_runs(repos, git, &item, &runs)?;
    let item = repos.mark_task_closed(id)?;
    Ok(CloseIssueReport {
        item,
        task_runs: runs.into_iter().map(|run| run.id.into()).collect(),
        removed_branches,
    })
}

fn cleanup_runs<R, G>(
    repos: &R,
    git: &G,
    item: &Task,
    runs: &[TaskRun],
) -> ApplicationResult<Vec<String>>
where
    R: ProjectRepository,
    G: GitGateway,
{
    if runs.is_empty() {
        return Ok(Vec::new());
    }

    let project_id = item.project_id.as_deref().ok_or_else(|| {
        ApplicationError::validation(format!(
            "{} has run records but is not linked to a project; refusing to close so run cleanup \
             metadata is preserved",
            item.id
        ))
    })?;
    let project = repos
        .get_project(project_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("project not found: {project_id}")))?;
    let repo_path = project.path.as_deref().ok_or_else(|| {
        ApplicationError::validation(format!(
            "project {project_id} has no checkout path; refusing to close {} so run cleanup \
             metadata is preserved",
            item.id
        ))
    })?;
    Ok(git
        .cleanup_task_runs(Path::new(repo_path), runs)
        .map_err(|e| ApplicationError::external(format!("failed to clean up git branches: {e:#}")))?)

}
