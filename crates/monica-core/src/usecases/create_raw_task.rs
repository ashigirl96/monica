use anyhow::{anyhow, Result};

use crate::interfaces::{ProjectRepository, TaskRepository};
use crate::{NewTask, Task, TaskKind};

/// Create a task that carries no GitHub issue ref ("raw task"). The title is the sole content;
/// `project_id` is required because raw tasks are meant to be prepared/run in a worktree, and
/// `start_run` rejects tasks without a project.
pub fn create_raw_task<R>(repos: &mut R, title: &str, project_id: &str) -> Result<Task>
where
    R: TaskRepository + ProjectRepository,
{
    let title = title.trim();
    if title.is_empty() {
        return Err(anyhow!("task title must not be empty"));
    }
    if repos.get_project(project_id)?.is_none() {
        return Err(anyhow!("project not found: {project_id}"));
    }

    let mut new = NewTask::new(TaskKind::Development, title);
    new.project_id = Some(project_id.to_string());
    repos.insert_task(new)
}
