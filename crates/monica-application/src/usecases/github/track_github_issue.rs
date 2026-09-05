use super::ports::{GithubGateway, GithubIssueSyncStore, ProjectRepository, TaskStore};
use crate::prelude::{
    parse_owner_repo, ExternalIssue, ExternalReference, NewTask, Provider, RefType, Task, TaskKind,
    TaskStatus,
};
use crate::{ApplicationError, ApplicationResult, GithubIssue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackGithubIssueInput {
    pub repo: String,
    pub number: i64,
}

/// Which side of the idempotency check tracking landed on. An issue already carried by an open
/// task resolves to that task instead of spawning a second one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackOutcome {
    Created,
    AlreadyTracked,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrackGithubIssueReport {
    pub repo: String,
    pub issue: ExternalIssue,
    pub task: Task,
    pub outcome: TrackOutcome,
}

pub async fn track_github_issue<R, G>(
    repos: &mut R,
    github: &G,
    input: TrackGithubIssueInput,
) -> ApplicationResult<TrackGithubIssueReport>
where
    R: TaskStore + ProjectRepository + GithubIssueSyncStore,
    G: GithubGateway,
{
    let repo = parse_owner_repo(&input.repo)?;
    let issue = github
        .fetch_issue(&repo, input.number)
        .await
        .map_err(|e| ApplicationError::external(format!("{e:#}")))?;
    let (task, outcome) = track_github_issue_from_fetched(repos, &repo, &issue)?;
    Ok(TrackGithubIssueReport {
        repo,
        issue: external_issue_from(&issue),
        task,
        outcome,
    })
}

fn external_issue_from(issue: &GithubIssue) -> ExternalIssue {
    ExternalIssue {
        number: issue.number,
        title: issue.title.clone(),
        body: issue.body.clone(),
        url: issue.url.clone(),
    }
}

pub fn track_github_issue_from_fetched<R>(
    repos: &mut R,
    repo_input: &str,
    issue: &GithubIssue,
) -> ApplicationResult<(Task, TrackOutcome)>
where
    R: TaskStore + ProjectRepository + GithubIssueSyncStore,
{
    let repo = parse_owner_repo(repo_input)?;
    // Re-tracking must resolve to the running attempt rather than fork a second task. The task row
    // itself is never rewritten; only the issue-ref cache below learns the fresh title.
    let (mut task, outcome) = match repos.find_open_task_by_external_ref(
        Provider::Github,
        RefType::Issue,
        &repo,
        issue.number,
    )? {
        Some(existing) => (existing, TrackOutcome::AlreadyTracked),
        None => (
            insert_tracked_task(repos, &repo, issue)?,
            TrackOutcome::Created,
        ),
    };

    repos.upsert_issue_ref_state(
        task.id.as_str(),
        &repo,
        issue.number,
        &issue.title,
        issue.state,
    )?;
    // Both branches read the task before the cache was seeded, so it still carries the previous
    // snapshot (or nothing, for a fresh row). The cache now holds `issue.title`, so that is what a
    // re-read would resolve to; assign it directly and let callers — `monica task track`'s output
    // and the desktop's TaskCreated among them — report what GitHub says right now.
    task.title = issue.title.clone();
    Ok((task, outcome))
}

fn insert_tracked_task<R>(repos: &mut R, repo: &str, issue: &GithubIssue) -> ApplicationResult<Task>
where
    R: TaskStore + ProjectRepository,
{
    let project_id = repos.get_project(repo)?.map(|p| p.id);

    // Title and body stay NULL: they belong to the issue, and baking a snapshot in is exactly
    // what left tracked tasks showing stale titles.
    let mut new = NewTask::untitled(TaskKind::Development);
    new.status = TaskStatus::Ready;
    new.project_id = project_id;

    let external = ExternalReference::new(
        String::new(),
        Provider::Github,
        RefType::Issue,
        Some(repo.to_string()),
        Some(issue.number),
        Some(issue.url.clone()),
    );
    Ok(repos.insert_task_with_ref(new, external)?)
}
