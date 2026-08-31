use std::path::Path;
use std::time::Duration;

use crate::prelude::{branch_name, monica_number, worktree_path_for};
use super::ports::{
    GitGateway, ProjectRepository, TaskRunOutputs, SetupEnv, SetupOutcome, SetupRunner,
    TaskRunStore, TaskStore, UnitOfWork, WorkbenchStore,
};
use crate::ports::TerminalSessionRepository;
use crate::prelude::{
    ExternalReference, NewTaskRun, Project, RefType, RunMode, Task, TaskId, TaskRun, TaskRunId,
    TaskRunStatus, TaskStatus,
};
use crate::{ApplicationError, ApplicationResult, ExecutionProfile, PrepareTaskResult};

fn is_active_run_status(status: TaskRunStatus) -> bool {
    matches!(
        status,
        TaskRunStatus::SettingUp | TaskRunStatus::Running | TaskRunStatus::WaitingForUser
    )
}

fn load_task_and_project<R>(
    repos: &R,
    task_id: &TaskId,
) -> ApplicationResult<(Task, Project)>
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
    Ok((task, project))
}

fn load_execution_profile<R>(repos: &R, project_id: &str) -> ApplicationResult<ExecutionProfile>
where
    R: ProjectRepository,
{
    Ok(repos.get_execution_profile(project_id)?.unwrap_or_default())
}

/// Shared by both run-creation paths: a closed task takes no new run, and the Main Run slot must
/// be free — nothing live, and nothing already prepared and waiting to launch.
fn ensure_task_accepts_new_run<R>(repos: &R, task: &Task) -> ApplicationResult<()>
where
    R: TaskRunStore,
{
    let task_id = &task.id;
    if task.status == TaskStatus::Closed {
        return Err(ApplicationError::validation(format!(
            "task {task_id} is closed; reopen it before preparing"
        )));
    }

    let Some(primary_id) = task.primary_task_run_id.as_ref() else {
        return Ok(());
    };
    let Some(primary_run) = repos.get_task_run(primary_id)? else {
        return Ok(());
    };
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
    Ok(())
}

fn primary_run<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<Option<TaskRun>>
where
    R: TaskStore + TaskRunStore,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    match task.primary_task_run_id {
        Some(id) => Ok(repos.get_task_run(&id)?),
        None => Ok(None),
    }
}

/// Phase 1: Create TaskRun (SettingUp) + set as Main Run + ensure bench exists.
/// Returns immediately so the UI can reflect `setting_up` without blocking.
pub fn start_run<R>(repos: &mut R, task_id: &TaskId) -> ApplicationResult<PrepareTaskResult>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore + UnitOfWork,
{
    let (task, project) = load_task_and_project(repos, task_id)?;
    ensure_task_accepts_new_run(repos, &task)?;

    let github_issue_number = latest_github_issue_number(repos, task_id)?;
    let mon = monica_number(task_id.as_str())?;
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
    tx.set_primary_task_run(&task.id, &run.id)?;
    super::open_bench::ensure_bench(&mut *tx, &task.id, &cwd, false)?;
    tx.commit()?;

    Ok(PrepareTaskResult {
        task_id: task.id,
        task_run_id: run.id,
        branch,
    })
}

/// Create an already-`Prepared` run carrying no branch and no worktree, and point the task's Main
/// Run at it. Nothing needs setting up: `project.path` is the user's own checkout, and the setup
/// script exists to provision a *fresh* worktree, so it is deliberately skipped.
///
/// `branch` stays `None` on purpose — naming the primary branch here would hand it to
/// `close_task`'s cleanup, which deletes every branch a run records.
fn start_in_place_run<R>(repos: &mut R, task_id: &TaskId) -> ApplicationResult<()>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore + UnitOfWork,
{
    let (task, project) = load_task_and_project(repos, task_id)?;
    ensure_task_accepts_new_run(repos, &task)?;
    // Validated before the run exists: there is no setup phase to fail into, so a run committed as
    // `Prepared` against an unusable checkout would leave the task with no way forward.
    let cwd = project_checkout(&project)?;

    // Same atomicity as `start_run`, plus the Prepared transition: there is no second phase to
    // reach it, so a run left at `SettingUp` here would never advance.
    let mut tx = repos.begin()?;
    let run = tx.start_task_run(NewTaskRun {
        task_id: task.id.clone(),
        agent: None,
        branch: None,
        worktree_path: None,
    })?;
    tx.set_primary_task_run(&task.id, &run.id)?;
    super::open_bench::ensure_bench(&mut *tx, &task.id, &cwd, false)?;
    tx.finish_task_run(&run.id, &task.id, TaskRunStatus::Prepared)?;
    tx.commit()?;

    Ok(())
}

/// Whether an in-place Run has to create a fresh TaskRun. A prepared primary is launched as it
/// stands and a stopped one with a recorded session is resumed in place, so the mode only decides
/// how a *new* run is born — never how an existing one is reopened.
fn needs_new_run(primary: Option<&TaskRun>) -> bool {
    match primary {
        None => true,
        Some(run) => run.status != TaskRunStatus::Prepared && run.resumable_session().is_none(),
    }
}

/// Entry point behind the board's RUN submenu. `mode` picks how a fresh run is created; when the
/// primary can already be launched or resumed, it is used as it stands and `mode` does not apply.
pub fn run_task<R, A>(
    repos: &mut R,
    outputs: &A,
    task_id: &TaskId,
    agent_override: Option<crate::prelude::Agent>,
    mode: RunMode,
) -> ApplicationResult<crate::RunTaskResult>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore + TerminalSessionRepository + UnitOfWork,
    A: TaskRunOutputs,
{
    if mode == RunMode::InPlace && needs_new_run(primary_run(repos, task_id)?.as_ref()) {
        start_in_place_run(repos, task_id)?;
    }
    prepare_claude_for_run(repos, outputs, task_id, agent_override)
}

/// Phase 2: Create worktree, run setup script, update TaskRun status, update bench cwd.
/// Intended to run on a background thread.
pub fn execute_run<R, G, S, A>(
    repos: &mut R,
    git: &G,
    setup_runner: &S,
    outputs: &A,
    task_id: &TaskId,
    task_run_id: &TaskRunId,
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
    task_id: &TaskId,
    task_run_id: &TaskRunId,
) -> ApplicationResult<TaskRunStatus>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore,
    G: GitGateway,
    S: SetupRunner,
    A: TaskRunOutputs,
{
    let (_, project) = load_task_and_project(repos, task_id)?;
    let profile = load_execution_profile(repos, &project.id)?;

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
        &SetupContext {
            task_run_id,
            task_id,
            worktree_path: &worktree_path,
            project: &project,
            profile: &profile,
            branch: &branch,
        },
    )?;

    if setup.is_failure() {
        repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Failed)?;
        return Ok(TaskRunStatus::Failed);
    }

    repos.update_bench_cwd(task_id, &worktree_str)?;

    repos.finish_task_run(task_run_id, task_id, TaskRunStatus::Prepared)?;

    Ok(TaskRunStatus::Prepared)
}

struct SetupContext<'a> {
    task_run_id: &'a TaskRunId,
    task_id: &'a TaskId,
    worktree_path: &'a Path,
    project: &'a Project,
    profile: &'a ExecutionProfile,
    branch: &'a str,
}

fn setup_phase<S, A>(
    setup_runner: &S,
    outputs: &A,
    ctx: &SetupContext<'_>,
) -> ApplicationResult<SetupOutcome>
where
    S: SetupRunner,
    A: TaskRunOutputs,
{
    let log_path = outputs
        .setup_log_path(ctx.task_run_id)
        .map_err(|e| ApplicationError::external(format!("failed to resolve setup log path: {e:#}")))?;
    let env = SetupEnv {
        monica_id: ctx.task_id.to_string(),
        task_run_id: ctx.task_run_id.to_string(),
        project_id: ctx.project.id.clone(),
        branch: ctx.branch.to_string(),
        worktree: ctx.worktree_path.to_string_lossy().into_owned(),
    };
    let timeout = Duration::from_secs(ctx.profile.setup_timeout_sec.max(0) as u64);
    setup_runner
        .run_setup_script(ctx.worktree_path, &log_path, &env, timeout)
        .map_err(|e| ApplicationError::external(format!("setup script failed to run: {e:#}")))
}

fn latest_github_issue_ref<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<Option<ExternalReference>>
where
    R: TaskStore,
{
    Ok(repos
        .list_external_refs(task_id)?
        .into_iter()
        .rfind(|r| r.ref_type == RefType::Issue))
}

fn latest_github_issue_number<R>(repos: &R, task_id: &TaskId) -> ApplicationResult<Option<i64>>
where
    R: TaskStore,
{
    Ok(latest_github_issue_ref(repos, task_id)?.and_then(|r| r.number))
}

/// Write hook config into the worktree's `.claude/settings.local.json` + wrapper script + PTY env
/// for a prepared run. A stopped primary that recorded an agent session is relaunched with the
/// agent's resume command instead — same run, same worktree, no new setup.
/// Does NOT transition the TaskRun — the SessionStart hook parks it at awaiting-prompt and
/// the first UserPromptSubmit moves it to Running.
pub fn prepare_claude_for_run<R, A>(
    repos: &mut R,
    outputs: &A,
    task_id: &TaskId,
    agent_override: Option<crate::prelude::Agent>,
) -> ApplicationResult<crate::RunTaskResult>
where
    R: TaskStore + TaskRunStore + ProjectRepository + WorkbenchStore + TerminalSessionRepository,
    A: TaskRunOutputs,
{
    let (task, project) = load_task_and_project(repos, task_id)?;
    let profile = load_execution_profile(repos, &project.id)?;

    let primary_id = task.primary_task_run_id.ok_or_else(|| {
        ApplicationError::validation(format!("task {task_id} has no primary run; prepare it first"))
    })?;
    let primary_run = repos
        .get_task_run(&primary_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("primary run {primary_id} not found")))?;

    let resume_session_id = match (primary_run.status, primary_run.resumable_session()) {
        (TaskRunStatus::Prepared, _) => None,
        (_, Some(session)) => Some(session.to_string()),
        (TaskRunStatus::Stopped, None) => {
            return Err(ApplicationError::conflict(format!(
                "primary run {primary_id} is stopped with no session to resume; prepare a new run"
            )));
        }
        (other, _) => {
            return Err(ApplicationError::conflict(format!(
                "primary run {primary_id} is {} (expected prepared or a resumable stopped run)",
                other.as_str()
            )));
        }
    };

    let cwd = launch_cwd(repos, &primary_run, &project)?;

    // A resumed session must reopen under the agent that recorded it — an override only applies
    // to fresh launches, so a resume can never be fed another agent's session.
    let agent = match resume_session_id {
        Some(_) => primary_run.agent.unwrap_or(profile.agent_default),
        None => agent_override.unwrap_or(profile.agent_default),
    };
    // Stamp the effective agent on the run: without this an overridden fresh launch leaves
    // `agent = NULL` behind and a later resume would fall back to the profile default.
    repos.set_task_run_agent(&primary_id, agent)?;

    let env = outputs
        .prepare_task_shell_env(task_id, &project, Some(&primary_id))
        .map_err(|e| ApplicationError::external(format!("failed to prepare shell env: {e:#}")))?;

    let (runspace_id, _, _) = super::open_bench::ensure_bench(repos, &task.id, &cwd, true)?;

    let initial_command = match resume_session_id {
        Some(session_id) => agent_resume_command(agent, &session_id),
        None => {
            let file_prompt = read_prompt_file(Path::new(&cwd));
            let prompt =
                resolve_prompt(latest_github_issue_ref(repos, task_id)?.is_some(), file_prompt);
            agent_initial_command(agent, prompt.as_deref())
        }
    };

    Ok(crate::RunTaskResult {
        task_id: task.id,
        task_run_id: primary_id,
        runspace_id,
        cwd,
        env,
        initial_command,
    })
}

/// Working directory a launch opens in.
///
/// A run that owns a worktree must open there, and a merely *missing* worktree stays an error: the
/// silent fallback would run an isolated branch's agent against the primary checkout (pinning the
/// bench there too), and `claude --resume` resolves its session by cwd, so it would not find the
/// session either. A run with no worktree at all — in-place, or attached — reopens in the cwd its
/// own terminal session recorded, and only failing that in the project checkout.
fn launch_cwd<R>(repos: &R, run: &TaskRun, project: &Project) -> ApplicationResult<String>
where
    R: TerminalSessionRepository,
{
    if let Some(worktree) = run.worktree_path.as_deref() {
        if !Path::new(worktree).is_dir() {
            return Err(ApplicationError::validation(format!(
                "worktree does not exist at {worktree}"
            )));
        }
        return Ok(worktree.to_string());
    }
    match tab_session_cwd(repos, run)? {
        Some(cwd) => Ok(cwd),
        None => project_checkout(project),
    }
}

/// The directory the run's own terminal session opened in. An attached run (`monica task attach`)
/// is the case that matters: its session was started wherever the user happened to be, and
/// `claude --resume` resolves a session by cwd, so reopening it anywhere else neither finds the
/// session nor operates on the files it was working with. A directory that has since gone away is
/// treated as no answer at all — resume cannot work there either way, and the caller's project
/// checkout is at least validated.
fn tab_session_cwd<R>(repos: &R, run: &TaskRun) -> ApplicationResult<Option<String>>
where
    R: TerminalSessionRepository,
{
    let Some(tab_id) = run.terminal_tab_id.as_deref() else {
        return Ok(None);
    };
    Ok(repos
        .latest_terminal_session_for_tab(tab_id)?
        .map(|session| session.cwd)
        .filter(|cwd| Path::new(cwd).is_dir()))
}

/// The project checkout a worktree-less run opens in.
///
/// Deliberately stricter than `default_bench_cwd`, which falls back to `$HOME` (then `/tmp`) so a
/// browsing shell always has somewhere to open: launching an agent outside the project is never
/// what Run meant. Missing and stale paths both fail here rather than at terminal spawn, because
/// a launch that dies after the run is `Prepared` strands the task — Prepare is disabled in that
/// state and Run just retries the same bad cwd, which `ensure_bench` has by then pinned.
fn project_checkout(project: &Project) -> ApplicationResult<String> {
    let path = project.path.as_deref().ok_or_else(|| {
        ApplicationError::validation(format!(
            "project {} has no checkout path; register it before running without a worktree",
            project.id
        ))
    })?;
    // `is_dir`, not `is_file`-tolerant `exists`: `monica project set <repo> path` takes any
    // nonempty string, and a regular file passes `exists` only to fail at terminal spawn.
    if !Path::new(path).is_dir() {
        return Err(ApplicationError::validation(format!(
            "project checkout is not a directory: {path}"
        )));
    }
    Ok(path.to_string())
}

/// Reads `.monica/prompt.md` from the run's working directory, returning the trimmed body only
/// when it carries an actual prompt. An empty or whitespace-only file means
/// "launch Claude bare".
fn read_prompt_file(cwd: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(cwd.join(".monica/prompt.md")).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `.monica/prompt.md` feeds Claude only for issue-backed tasks. A raw task launches Claude bare
/// regardless of what the prompt file happens to hold, so the explorer isn't seeded with a stale
/// prompt committed to the project repo.
fn resolve_prompt(has_github_issue: bool, file_prompt: Option<String>) -> Option<String> {
    has_github_issue.then_some(file_prompt).flatten()
}

fn agent_initial_command(agent: crate::prelude::Agent, prompt: Option<&str>) -> String {
    let bin = agent.as_str();
    match prompt {
        Some(prompt) => format!("{bin} {}", crate::shell::quote_single(prompt)),
        None => bin.to_string(),
    }
}

fn agent_resume_command(agent: crate::prelude::Agent, session_id: &str) -> String {
    let bin = agent.as_str();
    let sid = crate::shell::quote_single(session_id);
    format!("{bin} --resume {sid}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_command_quotes_session_id() {
        assert_eq!(
            agent_resume_command(crate::prelude::Agent::Claude, "sess-1"),
            "claude --resume 'sess-1'"
        );
    }

    #[test]
    fn empty_prompt_launches_agent_bare() {
        assert_eq!(agent_initial_command(crate::prelude::Agent::Claude, None), "claude");
    }

    #[test]
    fn prompt_is_passed_as_single_quoted_argument() {
        assert_eq!(
            agent_initial_command(crate::prelude::Agent::Claude, Some("fix the login bug")),
            "claude 'fix the login bug'"
        );
    }

    #[test]
    fn prompt_with_single_quote_is_escaped() {
        assert_eq!(
            agent_initial_command(crate::prelude::Agent::Claude, Some("don't break it")),
            "claude 'don'\\''t break it'"
        );
    }

    #[test]
    fn multiline_prompt_stays_within_one_quoted_argument() {
        assert_eq!(
            agent_initial_command(crate::prelude::Agent::Claude, Some("line one\nline two")),
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
