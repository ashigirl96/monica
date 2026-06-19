use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::status::{TaskRunStatus, TaskRunWaitReason};

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
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// An execution attempt against a task. Persisted from issue E onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub agent: Option<Agent>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub status: TaskRunStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
    pub settings_path: Option<String>,
    pub provider_session_id: Option<String>,
    pub terminal_tab_id: Option<String>,
    pub last_event_name: Option<String>,
    pub last_event_at: Option<String>,
    /// Subagents (Task tool) currently running under this run's Claude session. Keeps a `Stop`
    /// hook from demoting the run to "your turn" while a subagent is still in flight.
    pub active_subagents: i64,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}

/// A provider/hook observation applied to an existing [`TaskRun`].
#[derive(Debug, Clone, Copy)]
pub struct TaskRunObservation<'a> {
    pub status: Option<TaskRunStatus>,
    pub wait_reason: Option<Option<TaskRunWaitReason>>,
    pub event_name: Option<&'a str>,
    pub at: &'a str,
    pub provider_session_id: Option<&'a str>,
    pub terminal_tab_id: Option<&'a str>,
    pub metadata: Option<&'a Value>,
}

/// Input for starting a task run. The `id`, status, and timestamps are assigned by the store:
/// repository implementations always insert at [`TaskRunStatus::SettingUp`].
#[derive(Debug, Clone)]
pub struct NewTaskRun {
    pub task_id: String,
    pub agent: Option<Agent>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
}
