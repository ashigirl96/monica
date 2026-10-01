use std::path::Path;

use super::current_task::resolve_tab_id;
use super::ports::{GitGateway, ProjectRepository, TaskRunStore, TaskStore};
use super::TabIdentity;
use crate::github::GithubPullRequestStatus;
use crate::observability::{task_status, Line, LIFECYCLE};
use crate::ports::{PendingLaunchStore, TaskBoardQuery, TerminalSessionRepository, WorkbenchStore};
use crate::prelude::{Task, TaskId, TaskRun, TaskRunId, TaskRunStatus};
use crate::usecases::query::find_task_summary;
use crate::{ApplicationError, ApplicationResult};

#[derive(Debug, Clone, PartialEq)]
pub struct CloseTaskReport {
    pub task: Task,
    pub task_runs: Vec<String>,
    pub removed_branches: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct CloseTaskOptions<'a> {
    /// Close despite uncommitted changes, unpublished commits and live runs. A pinned tab still
    /// refuses: unpinning is the user's explicit word that the session may go.
    pub force: bool,
    /// Whoever asks for the close; its own run is not "another live run" standing in the way.
    pub caller: &'a TabIdentity,
}

/// Why a close would destroy something the user may still want.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseBlocker {
    PinnedTab,
    ActiveRun { run_id: TaskRunId, status: TaskRunStatus },
    UncommittedChanges { run_id: TaskRunId, worktree: String },
    UnpublishedCommits { run_id: TaskRunId, branch: String },
}

impl CloseBlocker {
    pub fn forceable(&self) -> bool {
        !matches!(self, CloseBlocker::PinnedTab)
    }

    pub fn message(&self) -> String {
        match self {
            CloseBlocker::PinnedTab => "a tab in this task's bench is pinned".to_string(),
            CloseBlocker::ActiveRun { run_id, status } => {
                let state = match status {
                    TaskRunStatus::WaitingForUser => "waiting for input",
                    _ => "running",
                };
                format!("{run_id} is still {state}")
            }
            CloseBlocker::UncommittedChanges { run_id, worktree } => {
                format!("worktree {worktree} ({run_id}) has uncommitted changes")
            }
            CloseBlocker::UnpublishedCommits { run_id, branch } => format!(
                "branch {branch} ({run_id}) has commits on no remote and no merged pull request"
            ),
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            CloseBlocker::PinnedTab => "pinned_tab",
            CloseBlocker::ActiveRun { .. } => "active_run",
            CloseBlocker::UncommittedChanges { .. } => "uncommitted_changes",
            CloseBlocker::UnpublishedCommits { .. } => "unpublished_commits",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CloseTaskOutcome {
    Closed(Box<CloseTaskReport>),
    /// Nothing was touched. Lists every blocker found, never just the first.
    Refused { blockers: Vec<CloseBlocker> },
}

/// Whether forcing would get past every blocker.
pub fn close_refusal_forceable(blockers: &[CloseBlocker]) -> bool {
    blockers.iter().all(CloseBlocker::forceable)
}

pub fn close_task<R, G>(
    repos: &mut R,
    git: &G,
    id: &TaskId,
    options: CloseTaskOptions<'_>,
) -> ApplicationResult<CloseTaskOutcome>
where
    R: TaskStore
        + TaskRunStore
        + ProjectRepository
        + PendingLaunchStore
        + WorkbenchStore
        + TerminalSessionRepository
        + TaskBoardQuery,
    G: GitGateway,
{
    let task = repos
        .get_task(id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {id}")))?;
    let runs = repos.list_task_runs_for_task(id)?;
    let blockers = close_blockers(repos, git, &task, &runs, options)?;
    if !blockers.is_empty() {
        let reasons = blockers.iter().map(CloseBlocker::reason).collect::<Vec<_>>().join(",");
        log::debug!(
            target: LIFECYCLE,
            "{}",
            Line::new("task_close_refused")
                .id("task_id", id)
                .id("reasons", &reasons)
                .finish()
        );
        return Ok(CloseTaskOutcome::Refused { blockers });
    }
    // Before the worktrees go: the task reads as open until `mark_task_closed`, so a launch the
    // desktop polls in between would otherwise open a tab in a directory that no longer exists.
    repos.remove_pending_launches_for_task(id)?;
    let removed_branches = cleanup_runs(repos, git, &task, &runs)?;
    crate::usecases::runs::reap_worktree_trash(repos, git);
    let closed = repos.mark_task_closed(id)?;
    task_status(id, task.status, closed.status, "close_task");
    Ok(CloseTaskOutcome::Closed(Box::new(CloseTaskReport {
        task: closed,
        task_runs: runs.into_iter().map(|run| run.id.into()).collect(),
        removed_branches,
    })))
}

fn close_blockers<R, G>(
    repos: &R,
    git: &G,
    task: &Task,
    runs: &[TaskRun],
    options: CloseTaskOptions<'_>,
) -> ApplicationResult<Vec<CloseBlocker>>
where
    R: ProjectRepository + WorkbenchStore + TerminalSessionRepository + TaskBoardQuery,
    G: GitGateway,
{
    let mut blockers = Vec::new();
    if let Some((runspace_id, _cwd)) = repos.get_bench_for_task(&task.id)? {
        if repos.runspace_has_pinned_tab(&runspace_id)? {
            blockers.push(CloseBlocker::PinnedTab);
        }
    }
    if options.force || runs.is_empty() {
        return Ok(blockers);
    }

    let caller_tab = resolve_tab_id(repos, options.caller)?;
    for run in runs {
        let live = matches!(run.status, TaskRunStatus::Running | TaskRunStatus::WaitingForUser);
        let is_caller = caller_tab.is_some() && run.terminal_tab_id == caller_tab;
        if live && !is_caller {
            blockers.push(CloseBlocker::ActiveRun { run_id: run.id.clone(), status: run.status });
        }
    }

    let (repo_path, default_branch) = repo_checkout(repos, task)?;
    let repo_path = Path::new(&repo_path);
    for run in runs {
        let Some(worktree) = run.worktree_path.as_deref() else { continue };
        if git
            .worktree_has_uncommitted_changes(repo_path, Path::new(worktree))
            .map_err(git_check_failed)?
        {
            blockers.push(CloseBlocker::UncommittedChanges {
                run_id: run.id.clone(),
                worktree: worktree.to_string(),
            });
        }
    }

    // Squash-merge leaves the branch's own commits reachable from nowhere, yet nothing is lost.
    if !has_merged_pull_request(repos, &task.id)? {
        let mut checked: Vec<&str> = Vec::new();
        for run in runs {
            let Some(branch) = run.branch.as_deref() else { continue };
            if checked.contains(&branch) {
                continue;
            }
            checked.push(branch);
            if git
                .branch_has_unpublished_commits(repo_path, branch, &default_branch)
                .map_err(git_check_failed)?
            {
                blockers.push(CloseBlocker::UnpublishedCommits {
                    run_id: run.id.clone(),
                    branch: branch.to_string(),
                });
            }
        }
    }
    Ok(blockers)
}

fn has_merged_pull_request<R>(repos: &R, id: &TaskId) -> ApplicationResult<bool>
where
    R: TaskBoardQuery,
{
    Ok(find_task_summary(repos, id)?.is_some_and(|summary| {
        summary
            .github_pull_requests
            .iter()
            .any(|pr| pr.parsed_status() == Some(GithubPullRequestStatus::Merged))
    }))
}

fn git_check_failed(e: anyhow::Error) -> ApplicationError {
    ApplicationError::external(format!("failed to inspect the task's git state: {e:#}"))
}

/// The checkout run cleanup operates on, and its default branch.
fn repo_checkout<R>(repos: &R, task: &Task) -> ApplicationResult<(String, String)>
where
    R: ProjectRepository,
{
    let project_id = task.project_id.as_deref().ok_or_else(|| {
        ApplicationError::validation(format!(
            "{} has run records but is not linked to a project; refusing to close so run cleanup \
             metadata is preserved",
            task.id
        ))
    })?;
    let project = repos
        .get_project(project_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("project not found: {project_id}")))?;
    let repo_path = project.path.ok_or_else(|| {
        ApplicationError::validation(format!(
            "project {project_id} has no checkout path; refusing to close {} so run cleanup \
             metadata is preserved",
            task.id
        ))
    })?;
    Ok((repo_path, project.default_branch))
}

fn cleanup_runs<R, G>(
    repos: &R,
    git: &G,
    task: &Task,
    runs: &[TaskRun],
) -> ApplicationResult<Vec<String>>
where
    R: ProjectRepository,
    G: GitGateway,
{
    if runs.is_empty() {
        return Ok(Vec::new());
    }
    let (repo_path, _default_branch) = repo_checkout(repos, task)?;
    git.cleanup_task_runs(Path::new(&repo_path), runs)
        .map_err(|e| ApplicationError::external(format!("failed to clean up git branches: {e:#}")))
}
