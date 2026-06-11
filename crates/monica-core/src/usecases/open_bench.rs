use anyhow::{anyhow, Result};

use crate::domain::bench_runspace_id;
use crate::interfaces::{
    BenchRepository, ProjectRepository, RunArtifacts, TaskRepository, TaskRunRepository,
};
use crate::{Project, Task, TaskBench};

pub(crate) fn default_bench_cwd(project: Option<&Project>, home_dir: Option<&str>) -> String {
    project
        .and_then(|p| p.path.clone())
        .or_else(|| home_dir.map(|s| s.to_string()))
        .unwrap_or_else(|| "/tmp".to_string())
}

pub(crate) fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Recompute the shell env for a task-connected runspace. Fails soft (empty vec) when the task
/// has no project or artifact generation fails, so terminals still open without Monica context.
pub fn task_shell_env<R, A>(
    repos: &R,
    artifacts: &A,
    task_id: &str,
) -> Result<Vec<(String, String)>>
where
    R: TaskRepository + ProjectRepository,
    A: RunArtifacts,
{
    let (task, project) = load_task_and_optional_project(repos, task_id)?;
    Ok(shell_env_for(artifacts, &task, project.as_ref()))
}

fn load_task_and_optional_project<R>(
    repos: &R,
    task_id: &str,
) -> Result<(Task, Option<Project>)>
where
    R: TaskRepository + ProjectRepository,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;
    let project = task
        .project_id
        .as_deref()
        .and_then(|pid| repos.get_project(pid).ok().flatten());
    Ok((task, project))
}

fn shell_env_for<A>(artifacts: &A, task: &Task, project: Option<&Project>) -> Vec<(String, String)>
where
    A: RunArtifacts,
{
    project
        .and_then(|p| artifacts.prepare_task_shell_env(&task.id, p, None).ok())
        .map(|shell| shell.env)
        .unwrap_or_default()
}

pub fn open_bench<R, A>(repos: &mut R, artifacts: &A, task_id: &str) -> Result<TaskBench>
where
    R: TaskRepository + TaskRunRepository + ProjectRepository + BenchRepository,
    A: RunArtifacts,
{
    let (task, project) = load_task_and_optional_project(repos, task_id)?;
    let env = shell_env_for(artifacts, &task, project.as_ref());

    if let Some((runspace_id, cwd)) = repos.get_bench_for_task(task_id)? {
        return Ok(TaskBench {
            task_id: task_id.to_string(),
            runspace_id,
            cwd,
            created: false,
            env,
        });
    }

    let cwd = resolve_worktree_cwd(repos, &task)
        .unwrap_or_else(|| default_bench_cwd(project.as_ref(), home_dir().as_deref()));

    let runspace_id = bench_runspace_id(task_id);
    repos.create_bench(task_id, &runspace_id, &cwd)?;

    Ok(TaskBench {
        task_id: task_id.to_string(),
        runspace_id,
        cwd,
        created: true,
        env,
    })
}

fn is_usable_worktree(path: &str) -> bool {
    !path.is_empty() && std::path::Path::new(path).exists()
}

fn resolve_worktree_cwd<R>(repos: &R, task: &Task) -> Option<String>
where
    R: TaskRunRepository,
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
