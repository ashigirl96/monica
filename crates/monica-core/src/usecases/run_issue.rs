use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};

use crate::domain::{branch_name, monica_number, worktree_path_for};
use crate::interfaces::{
    AgentLaunchMode, AgentLauncher, GitGateway, ProjectRepository, RunArtifacts, SetupEnv,
    SetupOutcome, SetupRunner, TaskRepository, TaskRunRepository,
};
use crate::{Agent, AgentLaunch, NewTaskRun, Project, RefType, TaskRunStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRunReport {
    pub task_id: String,
    pub task_run_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: TaskRunStatus,
    pub setup: SetupOutcome,
    pub log_path: String,
    pub settings_path: Option<String>,
    pub agent_launch: Option<AgentLaunch>,
}

pub fn run_issue<R, G, S, A>(
    repos: &mut R,
    git: &G,
    setup_runner: &S,
    artifacts: &A,
    task_id: &str,
    agent: Option<Agent>,
) -> Result<TaskRunReport>
where
    R: TaskRepository + TaskRunRepository + ProjectRepository,
    G: GitGateway,
    S: SetupRunner,
    A: RunArtifacts,
{
    run_issue_with_launch_mode(
        repos,
        git,
        setup_runner,
        artifacts,
        task_id,
        agent,
        AgentLaunchMode::New,
    )
}

pub fn run_issue_with_launch_mode<R, G, S, A>(
    repos: &mut R,
    git: &G,
    setup_runner: &S,
    artifacts: &A,
    task_id: &str,
    agent: Option<Agent>,
    launch_mode: AgentLaunchMode,
) -> Result<TaskRunReport>
where
    R: TaskRepository + TaskRunRepository + ProjectRepository,
    G: GitGateway,
    S: SetupRunner,
    A: RunArtifacts,
{
    if launch_mode.is_reconnect() && agent != Some(Agent::Claude) {
        return Err(anyhow!(
            "Claude session reconnect options require `--claude` or `--agent claude`"
        ));
    }

    let item = repos
        .get_task(task_id)?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;

    let project_id = item.project_id.clone().ok_or_else(|| {
        anyhow!(
            "{task_id} is not linked to a project; run `monica project init` in the repo, \
             then re-track the issue"
        )
    })?;
    let project = repos
        .get_project(&project_id)?
        .ok_or_else(|| anyhow!("project not found: {project_id}"))?;

    let github_issue_number = latest_github_issue_number(repos, task_id)?;
    let mon = monica_number(task_id)?;
    let branch = branch_name(github_issue_number, mon);

    if launch_mode.is_reconnect() {
        let target = reconnect_target(repos, task_id, &branch)?;
        if !target.worktree_path.exists() {
            return Err(anyhow!(
                "recorded worktree does not exist at {}; cannot reconnect {task_id}",
                target.worktree_path.display()
            ));
        }
        return run_existing_worktree(
            repos,
            artifacts,
            ExistingWorktreeRequest {
                task_id,
                agent,
                project: &project,
                branch: &target.branch,
                worktree_path: &target.worktree_path,
                launch_mode,
            },
        );
    }

    let repo_path = project.path.clone().ok_or_else(|| {
        anyhow!("project {project_id} has no checkout path; run `monica project init` in the repo")
    })?;
    let worktree_path = worktree_path_for(&project, &branch)?;

    if worktree_path.exists() {
        return Err(anyhow!(
            "worktree already exists at {}; {task_id} appears to have been run already \
             (remove it with `git worktree remove` to re-run)",
            worktree_path.display()
        ));
    }

    git.create_worktree(
        Path::new(&repo_path),
        &worktree_path,
        &branch,
        &project.default_branch,
    )?;

    let worktree_str = worktree_path.to_string_lossy().into_owned();
    let run = repos.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        agent,
        branch: Some(branch.clone()),
        worktree_path: Some(worktree_str.clone()),
    })?;

    let setup = match setup_phase(
        setup_runner,
        artifacts,
        &run.id,
        task_id,
        &worktree_path,
        &project,
        &branch,
    ) {
        Ok(setup) => setup,
        Err(e) => {
            let _ = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
            return Err(e);
        }
    };

    let setup_outcome = setup.outcome;
    let log_path = setup.log_path;

    if setup_outcome.is_failure() {
        repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed)?;
        return Ok(TaskRunReport {
            task_id: task_id.to_string(),
            task_run_id: run.id,
            branch,
            worktree_path: worktree_str,
            status: TaskRunStatus::Failed,
            setup: setup_outcome,
            log_path,
            settings_path: None,
            agent_launch: None,
        });
    }

    let (agent_launch, settings_path) = match agent {
        None => (None, None),
        Some(Agent::Claude) => {
            match artifacts.prepare_claude_launch(
                &run.id,
                task_id,
                &project,
                &worktree_path,
                &launch_mode,
            ) {
                Ok((launch, path)) => {
                    repos.set_task_run_settings_path(&run.id, &path)?;
                    (Some(launch), Some(path))
                }
                Err(e) => {
                    let _ = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
                    return Err(e);
                }
            }
        }
    };
    if let Err(e) = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Running) {
        let _ = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
        return Err(e);
    }

    Ok(TaskRunReport {
        task_id: task_id.to_string(),
        task_run_id: run.id,
        branch,
        worktree_path: worktree_str,
        status: TaskRunStatus::Running,
        setup: setup_outcome,
        log_path,
        settings_path,
        agent_launch,
    })
}

pub fn launch_agent<R, L>(repos: &mut R, launcher: &L, report: &TaskRunReport) -> Result<()>
where
    R: TaskRunRepository,
    L: AgentLauncher,
{
    let Some(launch) = report.agent_launch.as_ref() else {
        return Ok(());
    };
    match launcher.launch(launch) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ =
                repos.finish_task_run(&report.task_run_id, &report.task_id, TaskRunStatus::Failed);
            Err(e)
        }
    }
}

struct ReconnectTarget {
    branch: String,
    worktree_path: PathBuf,
}

fn reconnect_target<R>(repos: &R, task_id: &str, fallback_branch: &str) -> Result<ReconnectTarget>
where
    R: TaskRunRepository,
{
    let latest_run = repos
        .list_task_runs_for_task(task_id)?
        .into_iter()
        .rev()
        .find(|run| {
            run.worktree_path
                .as_deref()
                .is_some_and(|path| !path.is_empty())
        })
        .ok_or_else(|| {
            anyhow!("no recorded worktree for {task_id}; run `monica issue run` first")
        })?;
    let worktree_path = PathBuf::from(latest_run.worktree_path.expect("filtered above"));
    let branch = latest_run
        .branch
        .unwrap_or_else(|| fallback_branch.to_string());
    Ok(ReconnectTarget {
        branch,
        worktree_path,
    })
}

struct ExistingWorktreeRequest<'a> {
    task_id: &'a str,
    agent: Option<Agent>,
    project: &'a Project,
    branch: &'a str,
    worktree_path: &'a Path,
    launch_mode: AgentLaunchMode,
}

fn run_existing_worktree<R, A>(
    repos: &mut R,
    artifacts: &A,
    request: ExistingWorktreeRequest<'_>,
) -> Result<TaskRunReport>
where
    R: TaskRunRepository,
    A: RunArtifacts,
{
    let ExistingWorktreeRequest {
        task_id,
        agent,
        project,
        branch,
        worktree_path,
        launch_mode,
    } = request;
    let worktree_str = worktree_path.to_string_lossy().into_owned();
    let run = repos.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        agent,
        branch: Some(branch.to_string()),
        worktree_path: Some(worktree_str.clone()),
    })?;

    let log_path = match artifacts.write_reused_worktree_setup_log(&run.id) {
        Ok(path) => path,
        Err(e) => {
            let _ = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
            return Err(e);
        }
    };

    let (agent_launch, settings_path) = match artifacts.prepare_claude_launch(
        &run.id,
        task_id,
        project,
        worktree_path,
        &launch_mode,
    ) {
        Ok((launch, path)) => {
            repos.set_task_run_settings_path(&run.id, &path)?;
            (Some(launch), Some(path))
        }
        Err(e) => {
            let _ = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
            return Err(e);
        }
    };

    if let Err(e) = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Running) {
        let _ = repos.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
        return Err(e);
    }

    Ok(TaskRunReport {
        task_id: task_id.to_string(),
        task_run_id: run.id,
        branch: branch.to_string(),
        worktree_path: worktree_str,
        status: TaskRunStatus::Running,
        setup: SetupOutcome::ReusedWorktree,
        log_path,
        settings_path,
        agent_launch,
    })
}

struct SetupResult {
    outcome: SetupOutcome,
    log_path: String,
}

fn setup_phase<S, A>(
    setup_runner: &S,
    artifacts: &A,
    task_run_id: &str,
    task_id: &str,
    worktree_path: &Path,
    project: &Project,
    branch: &str,
) -> Result<SetupResult>
where
    S: SetupRunner,
    A: RunArtifacts,
{
    let log_path = artifacts.setup_log_path(task_run_id)?;
    let env = SetupEnv {
        monica_id: task_id.to_string(),
        task_run_id: task_run_id.to_string(),
        project_id: project.id.clone(),
        branch: branch.to_string(),
        worktree: worktree_path.to_string_lossy().into_owned(),
    };
    let timeout = Duration::from_secs(project.setup_timeout_sec.max(0) as u64);
    let outcome = setup_runner.run_setup_script(worktree_path, &log_path, &env, timeout)?;
    Ok(SetupResult {
        outcome,
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

fn latest_github_issue_number<R>(repos: &R, task_id: &str) -> Result<Option<i64>>
where
    R: TaskRepository,
{
    let refs = repos.list_external_refs(task_id)?;
    Ok(refs
        .into_iter()
        .rfind(|r| r.ref_type == RefType::GithubIssue)
        .and_then(|r| r.number))
}
