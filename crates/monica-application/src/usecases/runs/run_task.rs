use std::path::Path;
use std::time::Duration;

use anyhow::Result;

use crate::prelude::{branch_name, monica_number, worktree_path_for};
use super::ports::{
    GitGateway, ProjectRepository, TaskRunOutputs, SetupEnv, SetupOutcome, SetupRunner,
    TaskRunStore, TaskStore, UnitOfWork, WorkbenchStore,
};
use crate::{
    ApplicationError, ApplicationResult, ExecutionProfile, ExternalReference, NewTaskRun,
    PrepareTaskResult, Project, RefType, Task, TaskRunStatus, TaskStatus,
};

fn is_active_run_status(status: TaskRunStatus) -> bool {
    matches!(
        status,
        TaskRunStatus::SettingUp | TaskRunStatus::Running | TaskRunStatus::WaitingForUser
    )
}

fn load_task_and_project<R>(
    repos: &R,
    task_id: &str,
) -> ApplicationResult<(Task, Project, ExecutionProfile)>
where
    R: TaskStore + ProjectRepository,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    let project_id = task
        .project_id
        .as_deref()
        .ok_or_else(|| ApplicationError::validation(format!("{task_id} is not linked to a project")))?;
    let project = repos
        .get_project(project_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("project not found: {project_id}")))?;
    let profile = repos
        .get_execution_profile(project_id)?
        .unwrap_or_default();
    Ok((task, project, profile))
}

/// Phase 1: Create TaskRun (SettingUp) + set as Main Run + ensure bench exists.
/// Returns immediately so the UI can reflect `setting_up` without blocking.
pub fn start_run<R>(repos: &mut R, task_id: &str) -> ApplicationResult<PrepareTaskResult>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore + UnitOfWork,
{
    let (task, project, _profile) = load_task_and_project(repos, task_id)?;

    if task.status == TaskStatus::Closed {
        return Err(ApplicationError::validation(format!(
            "task {task_id} is closed; reopen it before preparing"
        )));
    }

    if let Some(ref primary_id) = task.primary_task_run_id {
        if let Some(primary_run) = repos.get_task_run(primary_id)? {
            if is_active_run_status(primary_run.status) {
                return Err(ApplicationError::conflict(format!(
                    "task {task_id} already has an active run ({primary_id}, status: {})",
                    primary_run.status.as_str()
                )));
            }
            if primary_run.status == TaskRunStatus::Prepared {
                return Err(ApplicationError::conflict(format!(
                    "task {task_id} is already prepared (run {primary_id}); use Run to launch Claude"
                )));
            }
        }
    }

    let github_issue_number = latest_github_issue_number(repos, task_id)?;
    let mon = monica_number(task_id)?;
    let branch = branch_name(github_issue_number, mon);
    let cwd = super::open_bench::default_bench_cwd(
        Some(&project),
        super::open_bench::home_dir().as_deref(),
    );

    // Run creation, the primary pointer, and the bench land as one transaction: a crash between
    // these steps would otherwise strand a run that has no primary pointer and no workbench.
    let mut tx = repos.begin()?;
    let run = tx.start_task_run(NewTaskRun {
        task_id: task.id.clone(),
        agent: None,
        branch: Some(branch.clone()),
        worktree_path: None,
    })?;
    tx.set_primary_task_run(task_id, &run.id)?;
    super::open_bench::ensure_bench(&mut *tx, task_id, &cwd, false)?;
    tx.commit()?;

    Ok(PrepareTaskResult {
        task_id: task_id.to_string(),
        task_run_id: run.id.into(),
        branch,
    })
}

/// Phase 2: Create worktree, run setup script, update TaskRun status, update bench cwd.
/// Intended to run on a background thread.
pub fn execute_run<R, G, S, A>(
    repos: &mut R,
    git: &G,
    setup_runner: &S,
    outputs: &A,
    task_id: &str,
    task_run_id: &str,
) -> ApplicationResult<TaskRunStatus>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore,
    G: GitGateway,
    S: SetupRunner,
    A: TaskRunOutputs,
{
    execute_run_inner(repos, git, setup_runner, outputs, task_id, task_run_id).inspect_err(
        |_| {
            let _ = repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Failed);
        },
    )
}

fn execute_run_inner<R, G, S, A>(
    repos: &mut R,
    git: &G,
    setup_runner: &S,
    outputs: &A,
    task_id: &str,
    task_run_id: &str,
) -> ApplicationResult<TaskRunStatus>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore,
    G: GitGateway,
    S: SetupRunner,
    A: TaskRunOutputs,
{
    let (_, project, profile) = load_task_and_project(repos, task_id)?;

    let run = repos
        .get_task_run(task_run_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task run not found: {task_run_id}")))?;
    let branch = run
        .branch
        .ok_or_else(|| ApplicationError::validation(format!("task run {task_run_id} has no branch")))?;

    let repo_path = project
        .path
        .clone()
        .ok_or_else(|| ApplicationError::validation(format!("project {} has no checkout path", project.id)))?;
    let worktree_path = worktree_path_for(&project, profile.worktree_root.as_deref(), &branch)?;
    let worktree_str = worktree_path.to_string_lossy().into_owned();

    if !worktree_path.exists() {
        git.create_worktree(
            std::path::Path::new(&repo_path),
            &worktree_path,
            &branch,
            &project.default_branch,
        )
        .map_err(|e| ApplicationError::external(format!("failed to create git worktree: {e:#}")))?;
    }

    repos.set_task_run_worktree_path(task_run_id, &worktree_str)?;

    let setup = setup_phase(
        setup_runner,
        outputs,
        task_run_id,
        task_id,
        &worktree_path,
        &project,
        &profile,
        &branch,
    )?;

    if setup.is_failure() {
        repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Failed)?;
        return Ok(TaskRunStatus::Failed);
    }

    repos.update_bench_cwd(task_id, &worktree_str)?;

    repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Prepared)?;

    Ok(TaskRunStatus::Prepared)
}

fn setup_phase<S, A>(
    setup_runner: &S,
    outputs: &A,
    task_run_id: &str,
    task_id: &str,
    worktree_path: &Path,
    project: &Project,
    profile: &ExecutionProfile,
    branch: &str,
) -> ApplicationResult<SetupOutcome>
where
    S: SetupRunner,
    A: TaskRunOutputs,
{
    let log_path = outputs
        .setup_log_path(task_run_id)
        .map_err(|e| ApplicationError::external(format!("failed to resolve setup log path: {e:#}")))?;
    let env = SetupEnv {
        monica_id: task_id.to_string(),
        task_run_id: task_run_id.to_string(),
        project_id: project.id.clone(),
        branch: branch.to_string(),
        worktree: worktree_path.to_string_lossy().into_owned(),
    };
    let timeout = Duration::from_secs(profile.setup_timeout_sec.max(0) as u64);
    setup_runner
        .run_setup_script(worktree_path, &log_path, &env, timeout)
        .map_err(|e| ApplicationError::external(format!("setup script failed to run: {e:#}")))
}

fn latest_github_issue_ref<R>(repos: &R, task_id: &str) -> Result<Option<ExternalReference>>
where
    R: TaskStore,
{
    Ok(repos
        .list_external_refs(task_id)?
        .into_iter()
        .rfind(|r| r.ref_type == RefType::Issue))
}

fn latest_github_issue_number<R>(repos: &R, task_id: &str) -> Result<Option<i64>>
where
    R: TaskStore,
{
    Ok(latest_github_issue_ref(repos, task_id)?.and_then(|r| r.number))
}

/// Write hook config into the worktree's `.claude/settings.local.json` + wrapper script + PTY env
/// for a prepared run.
/// Does NOT transition the TaskRun — the SessionStart hook parks it at awaiting-prompt and
/// the first UserPromptSubmit moves it to Running.
pub fn prepare_claude_for_run<R, A>(
    repos: &mut R,
    outputs: &A,
    task_id: &str,
    agent_override: Option<crate::Agent>,
) -> ApplicationResult<crate::RunTaskResult>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore,
    A: TaskRunOutputs,
{
    let (task, project, profile) = load_task_and_project(repos, task_id)?;

    let primary_id = task.primary_task_run_id.ok_or_else(|| {
        ApplicationError::validation(format!("task {task_id} has no primary run; prepare it first"))
    })?;
    let primary_run = repos
        .get_task_run(&primary_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("primary run {primary_id} not found")))?;

    if primary_run.status != TaskRunStatus::Prepared {
        return Err(ApplicationError::conflict(format!(
            "primary run {primary_id} is {} (expected prepared)",
            primary_run.status.as_str()
        )));
    }

    let worktree_str = primary_run.worktree_path.ok_or_else(|| {
        ApplicationError::validation(format!("primary run {primary_id} has no worktree path"))
    })?;
    let worktree_path = std::path::PathBuf::from(&worktree_str);
    if !worktree_path.exists() {
        return Err(ApplicationError::validation(format!(
            "worktree does not exist at {worktree_str}"
        )));
    }

    let agent = agent_override.unwrap_or(profile.agent_default);
    let mut effective_profile = profile;
    effective_profile.agent_default = agent;

    let shell = outputs
        .prepare_task_shell_env(task_id, &project, &effective_profile, Some(&primary_id), &worktree_path)
        .map_err(|e| ApplicationError::external(format!("failed to prepare shell env: {e:#}")))?;
    repos.set_task_run_settings_path(&primary_id, &shell.settings_path)?;

    let (runspace_id, _, _) = super::open_bench::ensure_bench(repos, task_id, &worktree_str, true)?;

    let file_prompt = read_prompt_file(&worktree_path);
    let prompt = resolve_prompt(latest_github_issue_ref(repos, task_id)?.is_some(), file_prompt);
    let initial_command = agent_initial_command(agent, prompt.as_deref());

    Ok(crate::RunTaskResult {
        task_id: task_id.to_string(),
        task_run_id: primary_id.into(),
        runspace_id,
        cwd: worktree_str,
        env: shell.env,
        initial_command,
    })
}

/// Reads `.monica/prompt.md` from the worktree, returning the trimmed body only
/// when it carries an actual prompt. An empty or whitespace-only file means
/// "launch Claude bare".
fn read_prompt_file(worktree_path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(worktree_path.join(".monica/prompt.md")).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `.monica/prompt.md` feeds Claude only for issue-backed tasks. A raw task launches Claude bare
/// regardless of what the worktree's prompt file happens to hold, so the explorer isn't seeded
/// with a stale prompt committed to the project repo.
fn resolve_prompt(has_github_issue: bool, file_prompt: Option<String>) -> Option<String> {
    has_github_issue.then_some(file_prompt).flatten()
}

fn agent_initial_command(agent: crate::Agent, prompt: Option<&str>) -> String {
    let bin = agent.as_str();
    match prompt {
        Some(prompt) => format!("{bin} {}", crate::shell::quote_single(prompt)),
        None => bin.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_prompt_launches_agent_bare() {
        assert_eq!(agent_initial_command(crate::Agent::Claude, None), "claude");
        assert_eq!(agent_initial_command(crate::Agent::Codex, None), "codex");
    }

    #[test]
    fn prompt_is_passed_as_single_quoted_argument() {
        assert_eq!(
            agent_initial_command(crate::Agent::Claude, Some("fix the login bug")),
            "claude 'fix the login bug'"
        );
        assert_eq!(
            agent_initial_command(crate::Agent::Codex, Some("fix the login bug")),
            "codex 'fix the login bug'"
        );
    }

    #[test]
    fn prompt_with_single_quote_is_escaped() {
        assert_eq!(
            agent_initial_command(crate::Agent::Claude, Some("don't break it")),
            "claude 'don'\\''t break it'"
        );
    }

    #[test]
    fn multiline_prompt_stays_within_one_quoted_argument() {
        assert_eq!(
            agent_initial_command(crate::Agent::Claude, Some("line one\nline two")),
            "claude 'line one\nline two'"
        );
    }

    #[test]
    fn raw_task_ignores_prompt_file() {
        assert_eq!(resolve_prompt(false, Some("seed".to_string())), None);
    }

    #[test]
    fn issue_task_uses_prompt_file_when_present() {
        assert_eq!(
            resolve_prompt(true, Some("seed".to_string())),
            Some("seed".to_string())
        );
    }

    #[test]
    fn issue_task_without_prompt_file_launches_bare() {
        assert_eq!(resolve_prompt(true, None), None);
    }
}
