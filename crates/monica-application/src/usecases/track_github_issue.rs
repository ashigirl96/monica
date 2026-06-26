use anyhow::Result;

use crate::ports::{GithubGateway, ProjectRepository, TaskRepository};
use crate::{
    parse_owner_repo, ExternalIssue, ExternalReference, GithubIssue, NewTask, Provider, RefType,
    Task, TaskKind, TaskStatus,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackGithubIssueInput {
    pub repo: String,
    pub number: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrackGithubIssueReport {
    pub repo: String,
    pub issue: ExternalIssue,
    pub task: Task,
}

pub async fn track_github_issue<R, G>(
    repos: &mut R,
    github: &G,
    input: TrackGithubIssueInput,
) -> Result<TrackGithubIssueReport>
where
    R: TaskRepository + ProjectRepository,
    G: GithubGateway,
{
    let repo = parse_owner_repo(&input.repo)?;
    let issue = github.fetch_issue(&repo, input.number).await?;
    let task = track_github_issue_from_fetched(repos, &repo, &issue)?;
    Ok(TrackGithubIssueReport {
        repo,
        issue: external_issue_from(&issue),
        task,
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
) -> Result<Task>
where
    R: TaskRepository + ProjectRepository,
{
    let repo = parse_owner_repo(repo_input)?;
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
    repos.insert_task_with_ref(new, external)
}
