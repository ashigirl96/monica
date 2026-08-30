use anyhow::Result;

use crate::bench::bench_runspace_id;
use super::ports::{
    ProjectRepository, TaskRunOutputs, TaskRunStore, TaskStore, WorkbenchStore,
};
use crate::prelude::{Project, RunspaceId, Task, TaskId};
use crate::{ApplicationError, ApplicationResult, TaskBench};

pub(crate) fn default_bench_cwd(project: Option<&Project>, home_dir: Option<&str>) -> String {
    project
        .and_then(|p| p.path.clone())
        .or_else(|| home_dir.map(|s| s.to_string()))
        .unwrap_or_else(|| "/tmp".to_string())
}

pub(crate) fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Get-or-create the task's bench runspace. Returns `(runspace_id, cwd, created)`. When the
/// bench already exists its cwd is kept, unless `pin_cwd` forces it to `desired_cwd` (used when
/// a run's worktree becomes the only sensible working directory).
pub(crate) fn ensure_bench<R>(
    repos: &mut R,
    task_id: &TaskId,
    desired_cwd: &str,
    pin_cwd: bool,
) -> Result<(RunspaceId, String, bool)>
where
    R: WorkbenchStore + ?Sized,
{
    if let Some((runspace_id, cwd)) = repos.get_bench_for_task(task_id)? {
        if pin_cwd {
            repos.update_bench_cwd(task_id, desired_cwd)?;
            return Ok((runspace_id, desired_cwd.to_string(), false));
        }
        return Ok((runspace_id, cwd, false));
    }
    let runspace_id = bench_runspace_id(task_id);
    repos.create_bench(task_id, &runspace_id, desired_cwd)?;
    Ok((runspace_id, desired_cwd.to_string(), true))
}

pub fn task_shell_env<R, A>(
    repos: &R,
    outputs: &A,
    task_id: &TaskId,
) -> ApplicationResult<Vec<(String, String)>>
where
    R: TaskStore + ProjectRepository,
    A: TaskRunOutputs,
{
    let (task, project) = load_task_and_optional_project(repos, task_id)?;
    let env = match project.as_ref() {
        Some(p) => outputs
            .prepare_task_shell_env(&task.id, p, None)
            .map_err(|e| ApplicationError::external(format!("failed to prepare shell env: {e:#}")))?,
        None => Vec::new(),
    };
    Ok(env)
}

fn load_task_and_optional_project<R>(
    repos: &R,
    task_id: &TaskId,
) -> ApplicationResult<(Task, Option<Project>)>
where
    R: TaskStore + ProjectRepository,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    let project = match task.project_id.as_deref() {
        Some(pid) => repos.get_project(pid)?,
        None => None,
    };
    Ok((task, project))
}

fn shell_env_for<A>(outputs: &A, task: &Task, project: Option<&Project>) -> Vec<(String, String)>
where
    A: TaskRunOutputs,
{
    project
        .and_then(|p| outputs.prepare_task_shell_env(&task.id, p, None).ok())
        .unwrap_or_default()
}

pub fn open_bench<R, A>(repos: &mut R, outputs: &A, task_id: &TaskId) -> ApplicationResult<TaskBench>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore,
    A: TaskRunOutputs,
{
    let (task, project) = load_task_and_optional_project(repos, task_id)?;

    let desired_cwd = resolve_worktree_cwd(repos, &task)
        .unwrap_or_else(|| default_bench_cwd(project.as_ref(), home_dir().as_deref()));
    let (runspace_id, cwd, created) = ensure_bench(repos, task_id, &desired_cwd, false)?;
    let env = shell_env_for(outputs, &task, project.as_ref());

    Ok(TaskBench {
        task_id: task.id,
        runspace_id,
        cwd,
        created,
        env,
    })
}

fn is_usable_worktree(path: &str) -> bool {
    !path.is_empty() && std::path::Path::new(path).exists()
}

fn resolve_worktree_cwd<R>(repos: &R, task: &Task) -> Option<String>
where
    R: TaskRunStore,
{
    task.primary_task_run_id
        .as_ref()
        .and_then(|run_id| repos.get_task_run(run_id).ok().flatten())
        .and_then(|run| run.worktree_path.filter(|p| is_usable_worktree(p)))
        .or_else(|| {
            let runs = repos.list_task_runs_for_task(&task.id).ok()?;
            runs.into_iter()
                .rev()
                .find_map(|run| run.worktree_path.filter(|p| is_usable_worktree(p)))
        })
}
