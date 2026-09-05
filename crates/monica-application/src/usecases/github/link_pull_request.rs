use super::ports::{GithubGateway, PullRequestSyncStore, TaskStore};
use crate::prelude::TaskId;
use crate::{ApplicationError, ApplicationResult, GithubPullRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkPullRequestReport {
    pub task_id: String,
    pub task_title: String,
    pub pull_request: GithubPullRequest,
}

/// Attach a pull request to a task by hand — the escape hatch for a PR the sync cannot find on its
/// own, such as one opened without a closing keyword on a task whose runs never took a branch. The
/// PR is fetched first so the recorded url and status come from GitHub rather than from the input.
pub async fn link_pull_request<R, G>(
    repos: &mut R,
    github: &G,
    task_id: &TaskId,
    repo: String,
    number: i64,
) -> ApplicationResult<LinkPullRequestReport>
where
    R: TaskStore + PullRequestSyncStore,
    G: GithubGateway,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    let pull_request = github
        .fetch_pull_request(&repo, number)
        .await
        .map_err(|e| ApplicationError::external(format!("{e:#}")))?;
    repos.record_linked_pull_requests(&[(task.id.as_str().to_string(), pull_request.clone())])?;
    Ok(LinkPullRequestReport {
        task_id: task.id.into(),
        task_title: task.title,
        pull_request,
    })
}
