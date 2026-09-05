use super::ports::{GithubGateway, GithubIssueSyncStore, PullRequestSyncStore};
use super::{bulk_sync_issues, bulk_sync_pull_requests};
use crate::{ApplicationResult, GithubSyncReport, GithubSyncScope};

/// The GitHub refresh behind cmd+r, the board's navigation trigger, and `monica task sync`: the PR
/// pass followed by the issue pass, each of which tolerates a per-repo failure on its own. Returns
/// their combined count so the completion event reports one number, along with what each pass
/// actually changed.
pub async fn bulk_sync_github<R, G>(
    repos: &mut R,
    github: &G,
    scope: &GithubSyncScope,
) -> ApplicationResult<GithubSyncReport>
where
    R: PullRequestSyncStore + GithubIssueSyncStore,
    G: GithubGateway,
{
    let (pull_requests, pull_request_changes) =
        bulk_sync_pull_requests(repos, github, scope).await?;
    let (issues, issue_changes) = bulk_sync_issues(repos, github, scope).await?;
    Ok(GithubSyncReport {
        synced_count: pull_requests + issues,
        issue_changes,
        pull_request_changes,
    })
}
