use anyhow::Result;

use crate::ports::{GithubGateway, TaskRepository};
use crate::PullRequestSyncResult;

pub async fn sync_next_pull_request<R, G>(
    repos: &mut R,
    github: &G,
) -> Result<PullRequestSyncResult>
where
    R: TaskRepository,
    G: GithubGateway,
{
    if let Some(candidate) = repos.next_pull_request_branch_sync_candidate()? {
        log::info!(
            target: "monica_application::pr_sync",
            "fetching pull requests by branch task_id={} repo={} branch={}",
            candidate.task_id,
            candidate.repo,
            candidate.branch
        );
        return match github
            .fetch_pull_requests_by_branch(&candidate.repo, &candidate.branch)
            .await
        {
            Ok(pull_requests) => {
                let count = pull_requests.len();
                repos.record_pull_request_branch_sync_success(&candidate, &pull_requests)?;
                log::info!(
                    target: "monica_application::pr_sync",
                    "branch pull request sync succeeded task_id={} repo={} branch={} pull_request_count={}",
                    candidate.task_id,
                    candidate.repo,
                    candidate.branch,
                    count
                );
                Ok(PullRequestSyncResult::synced(candidate.task_id, count))
            }
            Err(e) => {
                let message = format!("{e:#}");
                repos.record_pull_request_branch_sync_failure(&candidate, &message)?;
                log::warn!(
                    target: "monica_application::pr_sync",
                    "branch pull request sync failed task_id={} repo={} branch={} error={}",
                    candidate.task_id,
                    candidate.repo,
                    candidate.branch,
                    message
                );
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    }

    if let Some(candidate) = repos.next_pull_request_status_sync_candidate()? {
        log::info!(
            target: "monica_application::pr_sync",
            "refreshing pull request status task_id={} repo={} pull_request_number={}",
            candidate.task_id,
            candidate.repo,
            candidate.number
        );
        return match github
            .fetch_pull_request(&candidate.repo, candidate.number)
            .await
        {
            Ok(pull_request) => {
                repos.record_pull_request_status_sync_success(&candidate, &pull_request)?;
                log::info!(
                    target: "monica_application::pr_sync",
                    "pull request status sync succeeded task_id={} repo={} pull_request_number={} status={}",
                    candidate.task_id,
                    candidate.repo,
                    candidate.number,
                    pull_request.status.as_str()
                );
                Ok(PullRequestSyncResult::synced(candidate.task_id, 1))
            }
            Err(e) => {
                let message = format!("{e:#}");
                repos.record_pull_request_status_sync_failure(&candidate, &message)?;
                log::warn!(
                    target: "monica_application::pr_sync",
                    "pull request status sync failed task_id={} repo={} pull_request_number={} error={}",
                    candidate.task_id,
                    candidate.repo,
                    candidate.number,
                    message
                );
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    }

    log::debug!(target: "monica_application::pr_sync", "PR sync idle: no candidate");
    Ok(PullRequestSyncResult::idle())
}
