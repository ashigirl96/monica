mod api;
mod auth;
mod store;

use anyhow::Result;

use crate::{Db, PullRequestSyncResult};

pub use api::GithubApiClient;
pub use auth::{github_app_install_url, GithubAuthStatus, GithubDeviceFlow, GithubTokenProvider};

pub async fn sync_next_linked_pull_request(db: &mut Db) -> Result<PullRequestSyncResult> {
    let client = GithubApiClient::new();

    if let Some(candidate) = db.next_pull_request_sync_candidate()? {
        return match client
            .fetch_linked_pull_requests(&candidate.repo, candidate.issue_number)
            .await
        {
            Ok(pull_requests) => {
                let count = pull_requests.len();
                db.record_pull_request_sync_success(&candidate, &pull_requests)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, count))
            }
            Err(e) => {
                let message = format!("{e:#}");
                db.record_pull_request_sync_failure(&candidate, &message)?;
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    }

    if let Some(candidate) = db.next_pull_request_status_sync_candidate()? {
        return match client
            .fetch_pull_request(&candidate.repo, candidate.number)
            .await
        {
            Ok(pull_request) => {
                db.record_pull_request_status_sync_success(&candidate, &pull_request)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, 1))
            }
            Err(e) => {
                let message = format!("{e:#}");
                db.record_pull_request_status_sync_failure(&candidate, &message)?;
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    };

    Ok(PullRequestSyncResult::idle())
}
