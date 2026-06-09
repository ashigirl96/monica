use anyhow::{anyhow, Result};

use crate::interfaces::{BenchRepository, ProjectRepository, TaskRepository};
use crate::TaskBench;

pub fn open_bench<R>(repos: &mut R, task_id: &str) -> Result<TaskBench>
where
    R: TaskRepository + ProjectRepository + BenchRepository,
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

    let cwd = task
        .project_id
        .as_deref()
        .and_then(|pid| repos.get_project(pid).ok().flatten())
        .and_then(|p| p.path)
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

    let runspace_id = format!("bench-{task_id}");
    repos.create_bench(task_id, &runspace_id, &cwd)?;

    Ok(TaskBench {
        task_id: task_id.to_string(),
        runspace_id,
        cwd,
        created: true,
    })
}
