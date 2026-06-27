use super::ports::{ProjectRepository, TaskStore};
use crate::prelude::{NewTask, Task, TaskKind};
use crate::{ApplicationError, ApplicationResult};

/// Create a task that carries no GitHub issue ref ("raw task"). The title is the sole content;
/// `project_id` is required because raw tasks are meant to be prepared/run in a worktree, and
/// `start_run` rejects tasks without a project.
pub fn create_raw_task<R>(repos: &mut R, title: &str, project_id: &str) -> ApplicationResult<Task>
where
    R: TaskStore + ProjectRepository,
{
    let title = title.trim();
    if title.is_empty() {
        return Err(ApplicationError::validation("task title must not be empty"));
    }
    if repos.get_project(project_id)?.is_none() {
        return Err(ApplicationError::not_found(format!("project not found: {project_id}")));
    }

    let mut new = NewTask::new(TaskKind::Development, title);
    new.project_id = Some(project_id.to_string());
    Ok(repos.insert_task(new)?)
}
