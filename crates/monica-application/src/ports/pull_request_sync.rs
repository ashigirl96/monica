use anyhow::Result;

use crate::github::{
    GithubPullRequest, PullRequestBranchSyncCandidate, PullRequestSyncChange,
    UnresolvedPullRequestRef,
};

/// Pull-request sync bookkeeping for the forced bulk refresh. Separated from
/// [`TaskStore`](super::TaskStore) because it is GitHub-sync machinery, not task-aggregate
/// persistence.
pub trait PullRequestSyncStore {
    /// Every branch eligible for PR sync: a development task whose latest run is on a branch
    /// other than `main`/`master`/the project's default branch.
    fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>>;
    /// Every tracked PR whose recorded state is still in flight (no state row, unknown status,
    /// draft, or open), so the forced sync re-checks it even when its branch is no longer a
    /// candidate.
    fn all_unresolved_pull_request_refs(&self) -> Result<Vec<UnresolvedPullRequestRef>>;
    /// Persist a whole forced sync in one transaction. Each branch entry pairs a candidate with
    /// the PRs matched to it (empty when the repo listing carried none for that branch); each
    /// status entry pairs an unresolved ref with its freshly fetched PR.
    /// Returns only the refs whose status actually moved, plus the PRs the branch pass linked to
    /// a task for the first time.
    fn bulk_record_pr_sync(
        &mut self,
        branch_entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
        status_entries: &[(UnresolvedPullRequestRef, GithubPullRequest)],
    ) -> Result<Vec<PullRequestSyncChange>>;
}
