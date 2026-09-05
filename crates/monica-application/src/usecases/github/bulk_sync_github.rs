use super::ports::{GithubGateway, GithubIssueSyncStore, PullRequestSyncStore};
use super::{bulk_sync_issues, bulk_sync_pull_requests, BulkSyncOutcome};
use crate::ApplicationResult;

/// The forced GitHub refresh behind cmd+r and the board's navigation trigger: the PR pass followed
/// by the issue pass, each of which tolerates a per-repo failure on its own. Returns their combined
/// count so the completion event reports one number, plus the union of the repos neither pass could
/// read.
///
/// `task` narrows both passes to a single task's refs — `monica task sync MON-42`.
pub async fn bulk_sync_github<R, G>(
    repos: &mut R,
    github: &G,
    task: Option<&str>,
) -> ApplicationResult<BulkSyncOutcome>
where
    R: PullRequestSyncStore + GithubIssueSyncStore,
    G: GithubGateway,
{
    let pull_requests = bulk_sync_pull_requests(repos, github, task).await?;
    let issues = bulk_sync_issues(repos, github, task).await?;
    Ok(pull_requests.merge(issues))
}
