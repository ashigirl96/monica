use anyhow::Result;

use crate::interfaces::{GithubGateway, TaskRepository};
use crate::PullRequestSyncResult;

pub async fn sync_next_linked_pull_request<R, G>(
    repos: &mut R,
    github: &G,
) -> Result<PullRequestSyncResult>
where
    R: TaskRepository,
    G: GithubGateway,
{
    if let Some(candidate) = repos.next_pull_request_sync_candidate()? {
        return match github
            .fetch_linked_pull_requests(&candidate.repo, candidate.issue_number)
            .await
        {
            Ok(pull_requests) => {
                let count = pull_requests.len();
                repos.record_pull_request_sync_success(&candidate, &pull_requests)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, count))
            }
            Err(e) => {
                let message = format!("{e:#}");
                repos.record_pull_request_sync_failure(&candidate, &message)?;
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    }

    if let Some(candidate) = repos.next_pull_request_status_sync_candidate()? {
        return match github
            .fetch_pull_request(&candidate.repo, candidate.number)
            .await
        {
            Ok(pull_request) => {
                repos.record_pull_request_status_sync_success(&candidate, &pull_request)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, 1))
            }
            Err(e) => {
                let message = format!("{e:#}");
                repos.record_pull_request_status_sync_failure(&candidate, &message)?;
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    }

    Ok(PullRequestSyncResult::idle())
}
