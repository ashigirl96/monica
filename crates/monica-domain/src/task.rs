use serde::{Deserialize, Serialize};

use crate::ids::{TaskId, TaskRunId};
use crate::json::RawJson;
use crate::status::TaskStatus;

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum TaskKind {
    Development,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub phase: Option<String>,
    pub title: String,
    pub body: String,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: RawJson,
    pub source: Option<RawJson>,
    pub primary_task_run_id: Option<TaskRunId>,
    /// The task tracking this one's parent issue. Owned by the GitHub Sub-issues link, which the
    /// issue sync re-resolves on every run, so it is never set at insert time.
    pub parent_task_id: Option<TaskId>,
    pub closed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for inserting a [`Task`]. The `id` and timestamps are assigned by the store.
///
/// `title` and `body` are optional because a task backed by a GitHub issue owns neither. Its
/// title lives in the issue-ref state cache and the store resolves it on read; its body is simply
/// not kept — nothing reads `Task::body`, and a snapshot of it would go stale the same way the
/// title used to.
#[derive(Debug, Clone)]
pub struct NewTask {
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub title: Option<String>,
    pub body: Option<String>,
    pub phase: Option<String>,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: RawJson,
    pub source: Option<RawJson>,
}

impl NewTask {
    pub fn new(kind: TaskKind, title: impl Into<String>) -> Self {
        Self { title: Some(title.into()), ..Self::untitled(kind) }
    }

    /// A task whose title is owned elsewhere (a tracked GitHub issue).
    pub fn untitled(kind: TaskKind) -> Self {
        Self {
            kind,
            status: TaskStatus::Ready,
            title: None,
            body: None,
            phase: None,
            project_id: None,
            labels: Vec::new(),
            details: RawJson::empty_object(),
            source: None,
        }
    }
}

/// A status/hook event recorded against a task or run. Persisted from issue G onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub kind: String,
    pub payload: RawJson,
    pub created_at: String,
}
