use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::github::GithubPullRequestRef;
use super::status::{DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Development,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskKind::Development => "development",
        }
    }
}

impl FromStr for TaskKind {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "development" => TaskKind::Development,
            other => return Err(anyhow!("unknown task kind: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Task {
    pub id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub phase: Option<String>,
    pub title: String,
    pub body: String,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Any))]
    pub details: Value,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Any))]
    pub source: Option<Value>,
    pub primary_task_run_id: Option<String>,
    pub closed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskSummaryRow {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = Option<specta_typescript::Number>))]
    pub github_issue_number: Option<i64>,
    pub github_pull_requests: Vec<GithubPullRequestRef>,
    pub task_status: TaskStatus,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_run_wait_reason: Option<TaskRunWaitReason>,
    pub status: DisplayStatus,
    pub prepare_eligible: bool,
    pub run_eligible: bool,
    pub is_active: bool,
    pub has_open_pull_request: bool,
    pub branch: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub side_runs_running: i64,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub side_runs_waiting_for_user: i64,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub side_runs_failed: i64,
}

/// Input for inserting a [`Task`]. The `id` and timestamps are assigned by the store.
#[derive(Debug, Clone)]
pub struct NewTask {
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub title: String,
    pub body: String,
    pub phase: Option<String>,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: Value,
    pub source: Option<Value>,
}

impl NewTask {
    pub fn new(kind: TaskKind, title: impl Into<String>) -> Self {
        Self {
            kind,
            status: TaskStatus::Ready,
            title: title.into(),
            body: String::new(),
            phase: None,
            project_id: None,
            labels: Vec::new(),
            details: Value::Object(serde_json::Map::new()),
            source: None,
        }
    }
}

/// A status/hook event recorded against a task or run. Persisted from issue G onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Event {
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub id: i64,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub kind: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Any))]
    pub payload: Value,
    pub created_at: String,
}
