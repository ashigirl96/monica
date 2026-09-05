use super::ports::{GithubGateway, GithubIssueSyncStore, PullRequestSyncStore};
use super::{bulk_sync_issues, bulk_sync_pull_requests};
use crate::{ApplicationResult, GithubSyncReport, GithubSyncScope};

/// The GitHub refresh behind cmd+r, the board's navigation trigger, and `monica task sync`: the PR
/// pass followed by the issue pass, each of which tolerates a per-repo failure on its own. Returns
/// their combined count so the completion event reports one number, along with what each pass
/// changed and which repos neither could reach.
pub async fn bulk_sync_github<R, G>(
    repos: &mut R,
    github: &G,
    scope: &GithubSyncScope,
) -> ApplicationResult<GithubSyncReport>
where
    R: PullRequestSyncStore + GithubIssueSyncStore,
    G: GithubGateway,
{
    let pull_requests = bulk_sync_pull_requests(repos, github, scope).await?;
    let issues = bulk_sync_issues(repos, github, scope).await?;
    let mut failed_repos = pull_requests.failed_repos;
    failed_repos.extend(issues.failed_repos);
    failed_repos.sort();
    failed_repos.dedup();
    Ok(GithubSyncReport {
        synced_count: pull_requests.synced_count + issues.synced_count,
        issue_changes: issues.changes,
        pull_request_changes: pull_requests.changes,
        failed_repos,
    })
}
