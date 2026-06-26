use anyhow::Result;

use crate::prelude::{
    DisplayStatus, ExternalReference, GithubPullRequest, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, Task, TaskStatus, TaskSummaryRow,
};
use crate::NewTask;

/// How [`TaskRepository::list_task_summaries`] scopes which tasks come back. This is the query's
/// parameter, not a domain concept, so it lives beside the port rather than in `monica-domain`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSummaryFilter {
    /// Every task, including the Closed archive.
    All,
    /// Everything except the Closed archive.
    Active,
    /// Exactly one display status; Closed is reachable only when named here.
    Status(DisplayStatus),
}

impl TaskSummaryFilter {
    pub fn matches(self, status: DisplayStatus) -> bool {
        match self {
            TaskSummaryFilter::All => true,
            TaskSummaryFilter::Active => status != DisplayStatus::Closed,
            TaskSummaryFilter::Status(s) => s == status,
        }
    }
}

pub trait TaskRepository {
    fn insert_task(&mut self, new: NewTask) -> Result<Task>;
    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalReference) -> Result<Task>;
    fn get_task(&self, id: &str) -> Result<Option<Task>>;
    fn mark_task_closed(&mut self, id: &str) -> Result<Task>;
    fn list_tasks(&self) -> Result<Vec<Task>>;
    fn list_task_summaries(
        &self,
        filter: TaskSummaryFilter,
        project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>>;
    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()>;
    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()>;
    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()>;
    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalReference>>;
    fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>>;
    fn next_pull_request_status_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestStatusSyncCandidate>>;
    fn record_pull_request_branch_sync_success(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_summary_filter_matches_by_intent() {
        assert!(TaskSummaryFilter::All.matches(DisplayStatus::Closed));
        assert!(TaskSummaryFilter::All.matches(DisplayStatus::Ready));

        assert!(!TaskSummaryFilter::Active.matches(DisplayStatus::Closed));
        assert!(TaskSummaryFilter::Active.matches(DisplayStatus::Ready));
        assert!(TaskSummaryFilter::Active.matches(DisplayStatus::Running));

        let closed = TaskSummaryFilter::Status(DisplayStatus::Closed);
        assert!(closed.matches(DisplayStatus::Closed));
        assert!(!closed.matches(DisplayStatus::Ready));
    }
}
