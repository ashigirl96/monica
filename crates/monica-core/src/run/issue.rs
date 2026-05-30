use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::model::{Agent, NewTaskRun};
use crate::{paths, Db, Project, RefType, TaskRunStatus};

use super::agent::{build_claude_launch, AgentLaunchMode, TaskRunReport};
use super::branch::{branch_name, monica_number, worktree_path_for};
use super::setup::{run_setup_script, SetupEnv, SetupOutcome};
use super::worktree::create_worktree;

pub fn run_issue(db: &mut Db, task_id: &str, agent: Option<Agent>) -> Result<TaskRunReport> {
    run_issue_with_launch_mode(db, task_id, agent, AgentLaunchMode::New)
}

pub fn run_issue_with_launch_mode(
    db: &mut Db,
    task_id: &str,
    agent: Option<Agent>,
    launch_mode: AgentLaunchMode,
) -> Result<TaskRunReport> {
    if launch_mode.is_reconnect() && agent != Some(Agent::Claude) {
        return Err(anyhow!(
            "Claude session reconnect options require `--claude` or `--agent claude`"
        ));
    }

    let item = db
        .get_task(task_id)?
        .ok_or_else(|| anyhow!("task not found: {task_id}"))?;

    let project_id = item.project_id.clone().ok_or_else(|| {
        anyhow!(
            "{task_id} is not linked to a project; run `monica project init` in the repo, \
             then re-track the issue"
        )
    })?;
    let project = db
        .get_project(&project_id)?
        .ok_or_else(|| anyhow!("project not found: {project_id}"))?;

    let github_issue_number = latest_github_issue_number(db, task_id)?;
    let mon = monica_number(task_id)?;
    let branch = branch_name(github_issue_number, mon);

    if launch_mode.is_reconnect() {
        let target = reconnect_target(db, task_id, &branch)?;
        if !target.worktree_path.exists() {
            return Err(anyhow!(
                "recorded worktree does not exist at {}; cannot reconnect {task_id}",
                target.worktree_path.display()
            ));
        }
        return run_existing_worktree(
            db,
            task_id,
            agent,
            &project,
            &target.branch,
            &target.worktree_path,
            launch_mode,
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

    create_worktree(
        Path::new(&repo_path),
        &worktree_path,
        &branch,
        &project.default_branch,
    )?;

    let worktree_str = worktree_path.to_string_lossy().into_owned();
    let run = db.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        // Record the agent the caller actually asked for — `None` means "no launch requested",
        // not "default to claude" — so the persisted TaskRun is honest about what happened.
        agent,
        branch: Some(branch.clone()),
        worktree_path: Some(worktree_str.clone()),
    })?;

    // The task run is now `setting_up`. Any failure from here must settle it to `failed`, never
    // leave it stranded — so an error from setup_phase is caught and converted before propagating.
    let setup = match setup_phase(&run.id, task_id, &worktree_path, &project, &branch) {
        Ok(setup) => setup,
        Err(e) => {
            let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
            return Err(e);
        }
    };

    let setup_outcome = setup.outcome;
    let log_path = setup.log_path;

    if setup_outcome.is_failure() {
        db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed)?;
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

    // setup ok/skipped → prepare the agent's launch spec (if requested), then settle running.
    let (agent_launch, settings_path) = match agent {
        None => (None, None),
        Some(Agent::Claude) => {
            match build_claude_launch(db, &run.id, task_id, &project, &worktree_path, &launch_mode)
            {
                Ok((launch, path)) => (Some(launch), Some(path)),
                Err(e) => {
                    let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
                    return Err(e);
                }
            }
        }
    };
    if let Err(e) = db.finish_task_run(&run.id, task_id, TaskRunStatus::Running) {
        // Even the final settle must not leave the pair stranded in setting_up: re-settle to
        // failed before surfacing the original DB error.
        let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
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

struct ReconnectTarget {
    branch: String,
    worktree_path: PathBuf,
}

fn reconnect_target(db: &Db, task_id: &str, fallback_branch: &str) -> Result<ReconnectTarget> {
    let latest_run = db
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

fn run_existing_worktree(
    db: &mut Db,
    task_id: &str,
    agent: Option<Agent>,
    project: &Project,
    branch: &str,
    worktree_path: &Path,
    launch_mode: AgentLaunchMode,
) -> Result<TaskRunReport> {
    let worktree_str = worktree_path.to_string_lossy().into_owned();
    let run = db.start_task_run(NewTaskRun {
        task_id: task_id.to_string(),
        agent,
        branch: Some(branch.to_string()),
        worktree_path: Some(worktree_str.clone()),
    })?;

    let task_run_dir = paths::task_run_dir(&run.id)?;
    if let Err(e) = fs::create_dir_all(&task_run_dir)
        .with_context(|| format!("failed to create {}", task_run_dir.display()))
    {
        let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
        return Err(e);
    }
    let log_path = task_run_dir.join("setup.log");
    if let Err(e) = fs::write(
        &log_path,
        "monica: reusing existing worktree; setup skipped\n",
    )
    .with_context(|| format!("failed to write {}", log_path.display()))
    {
        let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
        return Err(e);
    }

    let (agent_launch, settings_path) =
        match build_claude_launch(db, &run.id, task_id, project, worktree_path, &launch_mode) {
            Ok((launch, path)) => (Some(launch), Some(path)),
            Err(e) => {
                let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
                return Err(e);
            }
        };

    if let Err(e) = db.finish_task_run(&run.id, task_id, TaskRunStatus::Running) {
        let _ = db.finish_task_run(&run.id, task_id, TaskRunStatus::Failed);
        return Err(e);
    }

    Ok(TaskRunReport {
        task_id: task_id.to_string(),
        task_run_id: run.id,
        branch: branch.to_string(),
        worktree_path: worktree_str,
        status: TaskRunStatus::Running,
        setup: SetupOutcome::ReusedWorktree,
        log_path: log_path.to_string_lossy().into_owned(),
        settings_path,
        agent_launch,
    })
}

struct SetupResult {
    outcome: SetupOutcome,
    log_path: String,
}

/// The fallible, DB-free steps between `start_task_run` and the final settle: create the run directory
/// and run `.monica/setup.sh`. Kept separate so the caller can guarantee a `failed` settle on any
/// error here.
fn setup_phase(
    task_run_id: &str,
    task_id: &str,
    worktree_path: &Path,
    project: &Project,
    branch: &str,
) -> Result<SetupResult> {
    let task_run_dir = paths::task_run_dir(task_run_id)?;
    fs::create_dir_all(&task_run_dir)
        .with_context(|| format!("failed to create {}", task_run_dir.display()))?;
    let log_path = task_run_dir.join("setup.log");
    let env = SetupEnv {
        monica_id: task_id.to_string(),
        task_run_id: task_run_id.to_string(),
        project_id: project.id.clone(),
        branch: branch.to_string(),
        worktree: worktree_path.to_string_lossy().into_owned(),
    };
    let timeout = Duration::from_secs(project.setup_timeout_sec.max(0) as u64);
    let outcome = run_setup_script(worktree_path, &log_path, &env, timeout)?;
    Ok(SetupResult {
        outcome,
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

fn latest_github_issue_number(db: &Db, task_id: &str) -> Result<Option<i64>> {
    let refs = db.list_external_refs(task_id)?;
    Ok(refs
        .into_iter()
        .rfind(|r| r.ref_type == RefType::GithubIssue)
        .and_then(|r| r.number))
}
