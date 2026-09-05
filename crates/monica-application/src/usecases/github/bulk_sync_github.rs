use super::ports::{GithubGateway, GithubIssueSyncStore, PullRequestSyncStore};
use super::{bulk_sync_issues, bulk_sync_pull_requests};
use crate::ApplicationResult;

/// The forced GitHub refresh behind cmd+r and the board's navigation trigger: the PR pass followed
/// by the issue pass, each of which tolerates a per-repo failure on its own. Returns their combined
/// count so the completion event reports one number.
pub async fn bulk_sync_github<R, G>(repos: &mut R, github: &G) -> ApplicationResult<u32>
where
    R: PullRequestSyncStore + GithubIssueSyncStore,
    G: GithubGateway,
{
    let pull_requests = bulk_sync_pull_requests(repos, github).await?;
    let issues = bulk_sync_issues(repos, github).await?;
    Ok(pull_requests + issues)
}
