use serde::{Deserialize, Serialize};

use crate::ids::{TaskId, TaskRunId};
use crate::json::RawJson;
use crate::status::{TaskRunStatus, TaskRunWaitReason};

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
    pub id: TaskRunId,
    pub task_id: TaskId,
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
    /// The Claude plan file (`~/.claude/plans/*.md`) most recently surfaced by an `ExitPlanMode`
    /// hook. Sticky: later hooks never clear it, so it survives plan approval.
    pub plan_file_path: Option<String>,
    /// A `Stop` was held by the subagent guard while the run was `Running` (its `background_tasks`
    /// still listed a running subagent). When a later `SubagentStop` leaves nothing in flight, the
    /// deferred `Stop → WaitingForUser` transition fires atomically.
    pub pending_stop: bool,
    pub metadata: RawJson,
    pub created_at: String,
    pub updated_at: String,
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

/// A task-run id is interpolated into worktree paths and shell-outs, so it must never enable path
/// traversal or option injection. Run ids the store mints are always safe; this guards ids that
/// arrive from hooks or other untrusted callers.
pub fn is_safe_task_run_id(task_run_id: &str) -> bool {
    !task_run_id.is_empty()
        && task_run_id != "."
        && task_run_id != ".."
        && !task_run_id.starts_with('-')
        && task_run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_task_run_id_accepts_run_ids_and_rejects_traversal() {
        assert!(is_safe_task_run_id("run-1"));
        assert!(is_safe_task_run_id("RUN.1-2_3"));
        assert!(!is_safe_task_run_id(""));
        assert!(!is_safe_task_run_id("."));
        assert!(!is_safe_task_run_id(".."));
        assert!(!is_safe_task_run_id("../x"));
        assert!(!is_safe_task_run_id("a/b"));
        assert!(!is_safe_task_run_id("-rf"));
    }
}
