use monica_domain::{DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus};
use serde::{Deserialize, Serialize};

use crate::github::GithubPullRequestRef;

/// A read model projecting a [`Task`](monica_domain::Task) plus its primary run and side-run
/// counts for the board/list views. Lives outside the `Task` aggregate (lightweight CQRS): it
/// composes domain status into a single [`DisplayStatus`] and precomputes the eligibility flags
/// the UI and CLI render, so neither has to know the rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSummaryRow {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    pub github_issue_number: Option<i64>,
    pub github_pull_requests: Vec<GithubPullRequestRef>,
    pub task_status: TaskStatus,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_run_wait_reason: Option<TaskRunWaitReason>,
    pub has_plan: bool,
    pub status: DisplayStatus,
    pub prepare_eligible: bool,
    pub run_eligible: bool,
    pub is_active: bool,
    pub has_open_pull_request: bool,
    pub branch: Option<String>,
    pub side_runs_running: i64,
    pub side_runs_waiting_for_user: i64,
    pub side_runs_failed: i64,
}
