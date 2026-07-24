use serde::{Deserialize, Serialize};

use crate::github::GithubPullRequestRef;
use crate::status::{DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus};

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TaskCreated {
    pub task_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ProjectOption {
    pub id: String,
    pub name: String,
}

impl From<monica_domain::Project> for ProjectOption {
    fn from(value: monica_domain::Project) -> Self {
        Self { id: value.id, name: value.name }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TaskSummaryRow {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub github_issue_number: Option<i64>,
    pub github_issue_url: Option<String>,
    pub github_pull_requests: Vec<GithubPullRequestRef>,
    pub task_status: TaskStatus,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_run_wait_reason: Option<TaskRunWaitReason>,
    pub has_plan: bool,
    pub has_memo: bool,
    pub status: DisplayStatus,
    pub prepare_eligible: bool,
    pub run_eligible: bool,
    pub is_active: bool,
    pub has_open_pull_request: bool,
    pub branch: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub side_runs_running: i64,
    #[specta(type = specta_typescript::Number)]
    pub side_runs_waiting_for_user: i64,
    #[specta(type = specta_typescript::Number)]
    pub side_runs_failed: i64,
}

impl From<monica_application::TaskSummaryRow> for TaskSummaryRow {
    fn from(value: monica_application::TaskSummaryRow) -> Self {
        Self {
            id: value.id,
            title: value.title,
            project: value.project,
            github_issue_number: value.github_issue_number,
            github_issue_url: value.github_issue_url,
            github_pull_requests: value
                .github_pull_requests
                .into_iter()
                .map(GithubPullRequestRef::from)
                .collect(),
            task_status: value.task_status.into(),
            task_run_status: value.task_run_status.map(TaskRunStatus::from),
            task_run_wait_reason: value.task_run_wait_reason.map(TaskRunWaitReason::from),
            has_plan: value.has_plan,
            has_memo: value.has_memo,
            status: value.status.into(),
            prepare_eligible: value.prepare_eligible,
            run_eligible: value.run_eligible,
            is_active: value.is_active,
            has_open_pull_request: value.has_open_pull_request,
            branch: value.branch,
            side_runs_running: value.side_runs_running,
            side_runs_waiting_for_user: value.side_runs_waiting_for_user,
            side_runs_failed: value.side_runs_failed,
        }
    }
}
