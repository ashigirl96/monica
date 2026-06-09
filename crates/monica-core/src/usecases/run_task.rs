use anyhow::{anyhow, Result};

use crate::domain::{branch_name, monica_number, worktree_path_for};
use crate::interfaces::{
    BenchRepository, GitGateway, ProjectRepository, RunArtifacts, SetupRunner, TaskRepository,
    TaskRunRepository,
};
use crate::{NewTaskRun, PrepareTaskResult, TaskRunStatus};

use super::run_issue::{latest_github_issue_number, setup_phase};

/// Phase 1: Create TaskRun (SettingUp) + set as Main Run + ensure bench exists.
/// Returns immediately so the UI can reflect `setting_up` without blocking.
pub fn start_run<R>(repos: &mut R, task_id: &str) -> Result<PrepareTaskResult>
where
    R: TaskRepository + TaskRunRepository + ProjectRepository + BenchRepository,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;

    let project_id = task.project_id.as_deref().ok_or_else(|| {
        anyhow!("{task_id} is not linked to a project")
    })?;
    let project = repos
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("project not found: {project_id}"))?;

    let github_issue_number = latest_github_issue_number(repos, task_id)?;
    let mon = monica_number(task_id)?;
    let branch = branch_name(github_issue_number, mon);

    let run = repos.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        agent: None,
        branch: Some(branch.clone()),
        worktree_path: None,
    })?;

    repos.set_primary_task_run(task_id, &run.id)?;

    let cwd = project
        .path
        .clone()
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));
    let runspace_id = format!("bench-{task_id}");
    match repos.get_bench_for_task(task_id)? {
        Some(_) => {}
        None => {
            repos.create_bench(task_id, &runspace_id, &cwd)?;
        }
    }

    Ok(PrepareTaskResult {
        task_id: task_id.to_string(),
        task_run_id: run.id,
        branch,
    })
}

/// Phase 2: Create worktree, run setup script, update TaskRun status, update bench cwd.
/// Intended to run on a background thread. Returns the final status as a string.
pub fn execute_run<R, G, S, A>(
    repos: &mut R,
    git: &G,
    setup_runner: &S,
    artifacts: &A,
    task_id: &str,
    task_run_id: &str,
) -> Result<String>
where
    R: TaskRepository + TaskRunRepository + ProjectRepository + BenchRepository,
    G: GitGateway,
    S: SetupRunner,
    A: RunArtifacts,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;

    let project_id = task.project_id.as_deref().ok_or_else(|| {
        anyhow!("{task_id} is not linked to a project")
    })?;
    let project = repos
        .get_project(project_id)?
        .ok_or_else(|| anyhow!("project not found: {project_id}"))?;

    let github_issue_number = latest_github_issue_number(repos, task_id)?;
    let mon = monica_number(task_id)?;
    let branch = branch_name(github_issue_number, mon);

    let repo_path = project.path.clone().ok_or_else(|| {
        anyhow!("project {project_id} has no checkout path")
    })?;
    let worktree_path = worktree_path_for(&project, &branch)?;
    let worktree_str = worktree_path.to_string_lossy().into_owned();

    if !worktree_path.exists() {
        git.create_worktree(
            std::path::Path::new(&repo_path),
            &worktree_path,
            &branch,
            &project.default_branch,
        )?;
    }

    // Update the TaskRun with the resolved worktree path
    repos.set_task_run_worktree_path(task_run_id, &worktree_str)?;

    let setup = match setup_phase(
        setup_runner,
        artifacts,
        task_run_id,
        task_id,
        &worktree_path,
        &project,
        &branch,
    ) {
        Ok(setup) => setup,
        Err(e) => {
            let _ = repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Failed);
            return Err(e);
        }
    };

    let final_status = if setup.outcome.is_failure() {
        repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Failed)?;
        TaskRunStatus::Failed
    } else {
        repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Prepared)?;
        TaskRunStatus::Prepared
    };

    repos.update_bench_cwd(task_id, &worktree_str)?;

    Ok(final_status.as_str().to_string())
}
