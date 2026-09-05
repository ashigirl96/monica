use anyhow::Result;

use crate::github::{GithubPullRequest, PullRequestBranchSyncCandidate, UnresolvedPullRequestRef};

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
    fn bulk_record_pr_sync(
        &mut self,
        branch_entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
        status_entries: &[(UnresolvedPullRequestRef, GithubPullRequest)],
    ) -> Result<()>;
    /// Attach pull requests to tasks the branch pass cannot reach — the issue reverse lookup and
    /// the manual CLI link. Each entry pairs a task id with the PR to record; the write upserts the
    /// ref and its status, so relinking the same PR never yields a second row.
    fn record_linked_pull_requests(&mut self, entries: &[(String, GithubPullRequest)])
        -> Result<()>;
}
