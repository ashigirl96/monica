use anyhow::{anyhow, Result};

use crate::interfaces::{BenchRepository, ProjectRepository, TaskRepository, TaskRunRepository};
use crate::TaskBench;

pub fn open_bench<R>(repos: &mut R, task_id: &str) -> Result<TaskBench>
where
    R: TaskRepository + TaskRunRepository + ProjectRepository + BenchRepository,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;

    if let Some((runspace_id, cwd)) = repos.get_bench_for_task(task_id)? {
        return Ok(TaskBench {
            task_id: task_id.to_string(),
            runspace_id,
            cwd,
            created: false,
        });
    }

    let worktree_cwd = resolve_worktree_cwd(repos, &task);

    let cwd = worktree_cwd.unwrap_or_else(|| {
        task.project_id
            .as_deref()
            .and_then(|pid| repos.get_project(pid).ok().flatten())
            .and_then(|p| p.path)
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
    });

    let runspace_id = format!("bench-{task_id}");
    repos.create_bench(task_id, &runspace_id, &cwd)?;

    Ok(TaskBench {
        task_id: task_id.to_string(),
        runspace_id,
        cwd,
        created: true,
    })
}

fn resolve_worktree_cwd<R>(repos: &R, task: &crate::Task) -> Option<String>
where
    R: TaskRunRepository,
{
    if let Some(ref run_id) = task.primary_task_run_id {
        if let Ok(Some(run)) = repos.get_task_run(run_id) {
            if let Some(ref path) = run.worktree_path {
                if !path.is_empty() && std::path::Path::new(path).exists() {
                    return Some(path.clone());
                }
            }
        }
    }

    let runs = repos.list_task_runs_for_task(&task.id).ok()?;
    runs.into_iter()
        .rev()
        .find_map(|run| {
            run.worktree_path.filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
        })
}
