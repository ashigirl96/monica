use anyhow::Result;

use crate::github::{FetchedIssue, GithubIssueState, OpenIssueRef};

/// Issue-sync bookkeeping, the mirror of [`PullRequestSyncStore`](super::PullRequestSyncStore).
/// Separated from [`TaskStore`](super::TaskStore) because it caches what GitHub owns rather than
/// persisting the task aggregate.
pub trait GithubIssueSyncStore {
    /// The issue ref of every task that is not closed. A closed task's issue needs no freshness.
    fn all_open_task_issue_refs(&self) -> Result<Vec<OpenIssueRef>>;
    /// Persist a whole forced sync in one transaction, one entry per external_ref id.
    fn bulk_record_issue_sync(&mut self, entries: &[(i64, FetchedIssue)]) -> Result<()>;
    /// Seed the cache for a single tracked issue, resolving the external_ref from its address.
    /// Lets `track` show the right title immediately instead of waiting for the next sync.
    fn upsert_issue_ref_state(
        &mut self,
        task_id: &str,
        repo: &str,
        number: i64,
        title: &str,
        state: GithubIssueState,
    ) -> Result<()>;
}
