use anyhow::Result;

use crate::bench::bench_runspace_id;
use super::ports::{
    ProjectRepository, TaskRunOutputs, TaskRunStore, TaskStore, WorkbenchStore,
};
use crate::prelude::{Project, Task};
use crate::{ApplicationError, ApplicationResult, ExecutionProfile, TaskBench};

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
    task_id: &str,
    desired_cwd: &str,
    pin_cwd: bool,
) -> Result<(String, String, bool)>
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

/// Recompute the shell env for a task-connected runspace. Fails soft (empty vec) when the task
/// has no project or output generation fails, so terminals still open without Monica context.
pub fn task_shell_env<R, A>(
    repos: &R,
    outputs: &A,
    task_id: &str,
) -> ApplicationResult<Vec<(String, String)>>
where
    R: TaskStore + ProjectRepository + TaskRunStore + WorkbenchStore,
    A: TaskRunOutputs,
{
    let (task, project) = load_task_and_optional_project(repos, task_id)?;
    let cwd = repos
        .get_bench_for_task(task_id)?
        .map(|(_, cwd)| cwd)
        .or_else(|| resolve_worktree_cwd(repos, &task))
        .unwrap_or_else(|| default_bench_cwd(project.as_ref(), home_dir().as_deref()));
    let profile = load_optional_profile(repos, project.as_ref())?.map(|mut prof| {
        if let Some(agent) = primary_run_agent(repos, &task) {
            prof.agent_default = agent;
        }
        prof
    });
    Ok(shell_env_for(outputs, &task, project.as_ref(), profile.as_ref(), &cwd))
}

fn primary_run_agent<R>(repos: &R, task: &Task) -> Option<crate::prelude::Agent>
where
    R: TaskRunStore,
{
    task.primary_task_run_id
        .as_ref()
        .and_then(|id| repos.get_task_run(id).ok().flatten())
        .and_then(|run| run.agent)
}

fn load_task_and_optional_project<R>(
    repos: &R,
    task_id: &str,
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

fn load_optional_profile<R>(
    repos: &R,
    project: Option<&Project>,
) -> ApplicationResult<Option<ExecutionProfile>>
where
    R: ProjectRepository,
{
    match project {
        Some(p) => Ok(repos.get_execution_profile(&p.id)?),
        None => Ok(None),
    }
}

fn shell_env_for<A>(
    outputs: &A,
    task: &Task,
    project: Option<&Project>,
    profile: Option<&ExecutionProfile>,
    cwd: &str,
) -> Vec<(String, String)>
where
    A: TaskRunOutputs,
{
    project
        .zip(profile)
        .and_then(|(p, prof)| {
            outputs
                .prepare_task_shell_env(&task.id, p, prof, None, std::path::Path::new(cwd))
                .ok()
        })
        .map(|shell| shell.env)
        .unwrap_or_default()
}

pub fn open_bench<R, A>(repos: &mut R, outputs: &A, task_id: &str) -> ApplicationResult<TaskBench>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore,
    A: TaskRunOutputs,
{
    let (task, project) = load_task_and_optional_project(repos, task_id)?;

    let desired_cwd = resolve_worktree_cwd(repos, &task)
        .unwrap_or_else(|| default_bench_cwd(project.as_ref(), home_dir().as_deref()));
    let (runspace_id, cwd, created) = ensure_bench(repos, task_id, &desired_cwd, false)?;

    // Write hook settings into the cwd Claude will actually launch in (the bench's resolved cwd,
    // which may differ from desired_cwd when the bench already existed).
    let profile = load_optional_profile(repos, project.as_ref())?;
    let env = shell_env_for(outputs, &task, project.as_ref(), profile.as_ref(), &cwd);

    Ok(TaskBench {
        task_id: task_id.to_string(),
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
