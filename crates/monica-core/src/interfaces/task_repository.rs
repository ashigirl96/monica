use anyhow::Result;

use crate::domain::{
    DisplayStatus, ExternalRef, GithubPullRequest, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncCandidate, Task, TaskStatus, TaskSummaryRow,
};
use crate::NewTask;

pub trait TaskRepository {
    fn insert_task(&mut self, new: NewTask) -> Result<Task>;
    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalRef) -> Result<Task>;
    fn get_task(&self, id: &str) -> Result<Option<Task>>;
    fn mark_task_deleted(&mut self, id: &str) -> Result<Task>;
    fn list_tasks(&self) -> Result<Vec<Task>>;
    fn list_task_summaries(
        &self,
        status: Option<DisplayStatus>,
        project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>>;
    fn set_primary_task_run(&self, task_id: &str, task_run_id: &str) -> Result<()>;
    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<()>;
    fn mark_task(&mut self, id: &str, status: TaskStatus, note: Option<&str>) -> Result<()>;
    fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalRef>>;
    fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>>;
    fn next_pull_request_sync_candidate(&self) -> Result<Option<PullRequestSyncCandidate>>;
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
    fn record_pull_request_sync_success(
        &mut self,
        candidate: &PullRequestSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()>;
    fn record_pull_request_sync_failure(
        &mut self,
        candidate: &PullRequestSyncCandidate,
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
