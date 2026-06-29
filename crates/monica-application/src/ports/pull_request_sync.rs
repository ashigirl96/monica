use anyhow::Result;

use crate::github::{
    GithubPullRequest, PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate,
};

/// Pull-request sync bookkeeping: pick the next branch/status sync candidate and record its
/// success or failure. Separated from [`TaskStore`](super::TaskStore) because it is GitHub-sync
/// machinery, not task-aggregate persistence.
pub trait PullRequestSyncStore {
    fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>>;
    fn next_pull_request_status_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestStatusSyncCandidate>>;
    /// Every branch eligible for PR sync, ignoring the per-branch retry backoff. "Eligible" is the
    /// same rule the periodic candidate uses: a development task whose latest run is on a branch
    /// other than `main`/`master`/the project's default branch. The forced bulk sweep re-checks all
    /// of them at once instead of draining one stale candidate per request.
    fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>>;
    fn record_pull_request_branch_sync_success(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()>;
    /// Record several branches' PRs in one transaction. Each entry pairs a branch candidate with the
    /// PRs matched to it (empty when the repo listing carried none for that branch).
    fn bulk_record_branch_sync_success(
        &mut self,
        entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
    ) -> Result<()>;
    fn record_pull_request_branch_sync_failure(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        error: &str,
    ) -> Result<()>;
    fn record_pull_request_status_sync_success(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        pull_request: &GithubPullRequest,
    ) -> Result<()>;
    fn record_pull_request_status_sync_failure(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        error: &str,
    ) -> Result<()>;
    /// Reset PR status-sync retry state so a user-forced sync re-checks open/draft PRs now.
    fn force_clear_pr_sync_state(&mut self) -> Result<()>;
}
