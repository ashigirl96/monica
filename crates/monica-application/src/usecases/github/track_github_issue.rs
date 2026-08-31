use super::ports::{GithubGateway, ProjectRepository, TaskStore};
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
    R: TaskStore + ProjectRepository,
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
    R: TaskStore + ProjectRepository,
{
    let repo = parse_owner_repo(repo_input)?;
    // Re-tracking must resolve to the running attempt rather than fork a second task. The
    // existing task's title and body are left as they are: re-syncing them is a separate concern.
    if let Some(existing) =
        repos.find_open_task_by_external_ref(Provider::Github, RefType::Issue, &repo, issue.number)?
    {
        return Ok((existing, TrackOutcome::AlreadyTracked));
    }
    let project_id = repos.get_project(&repo)?.map(|p| p.id);

    let mut new = NewTask::new(TaskKind::Development, &issue.title);
    new.status = TaskStatus::Ready;
    new.body = issue.body.clone().unwrap_or_default();
    new.project_id = project_id;

    let external = ExternalReference::new(
        String::new(),
        Provider::Github,
        RefType::Issue,
        Some(repo),
        Some(issue.number),
        Some(issue.url.clone()),
    );
    Ok((repos.insert_task_with_ref(new, external)?, TrackOutcome::Created))
}
