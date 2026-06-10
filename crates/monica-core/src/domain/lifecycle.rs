use serde_json::Value;

use super::{TaskRunStatus, TaskRunWaitReason};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookTransition {
    pub status: TaskRunStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
}

pub fn status_for_claude_event(event_name: &str) -> Option<TaskRunStatus> {
    match event_name {
        "SessionStart" => Some(TaskRunStatus::Running),
        "UserPromptSubmit" => Some(TaskRunStatus::Running),
        "Stop" => Some(TaskRunStatus::Stopped),
        "StopFailure" => Some(TaskRunStatus::Failed),
        "SessionEnd" => Some(TaskRunStatus::Stopped),
        _ => None,
    }
}

pub fn wait_reason_for_tool(tool_name: &str) -> Option<TaskRunWaitReason> {
    match tool_name {
        "AskUserQuestion" => Some(TaskRunWaitReason::AskUserQuestion),
        "ExitPlanMode" => Some(TaskRunWaitReason::ExitPlanMode),
        _ => None,
    }
}

pub fn transition_for_claude_event(
    event_name: &str,
    payload: Option<&Value>,
) -> Option<HookTransition> {
    if event_name == "PreToolUse" {
        let wait_reason = payload
            .and_then(|value| value.get("tool_name"))
            .and_then(Value::as_str)
            .and_then(wait_reason_for_tool)?;
        return Some(HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(wait_reason),
        });
    }
    if event_name == "PostToolUse" {
        payload
            .and_then(|value| value.get("tool_name"))
            .and_then(Value::as_str)
            .and_then(wait_reason_for_tool)?;
        return Some(HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        });
    }

    status_for_claude_event(event_name).map(|status| HookTransition {
        status,
        wait_reason: None,
    })
}

pub fn transition_is_protected(current: TaskRunStatus, next: TaskRunStatus) -> bool {
    matches!(current, TaskRunStatus::Failed)
        || (matches!(current, TaskRunStatus::WaitingForUser)
            && matches!(next, TaskRunStatus::Stopped))
}

/// Events that prove a user is actively driving a session in this shell. Only these may claim
/// or create runs; anything else (a stray `Stop` from an untracked session, a broken payload)
/// must never mutate the run set.
pub fn is_session_starting_event(event_name: Option<&str>) -> bool {
    matches!(event_name, Some("SessionStart" | "UserPromptSubmit"))
}

pub fn should_ignore_claude_event(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    matches!(event_name, Some("PreToolUse" | "PostToolUse"))
        && payload
            .and_then(|value| value.get("tool_name"))
            .and_then(Value::as_str)
            .and_then(wait_reason_for_tool)
            .is_none()
}

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
    use serde_json::json;

    use super::*;

    #[test]
    fn status_mapping_covers_lifecycle_events() {
        assert_eq!(
            status_for_claude_event("SessionStart"),
            Some(TaskRunStatus::Running)
        );
        assert_eq!(
            status_for_claude_event("UserPromptSubmit"),
            Some(TaskRunStatus::Running)
        );
        assert_eq!(
            status_for_claude_event("Stop"),
            Some(TaskRunStatus::Stopped)
        );
        assert_eq!(
            status_for_claude_event("StopFailure"),
            Some(TaskRunStatus::Failed)
        );
        assert_eq!(
            status_for_claude_event("SessionEnd"),
            Some(TaskRunStatus::Stopped)
        );
        assert_eq!(status_for_claude_event("PreToolUse"), None);
        assert_eq!(status_for_claude_event("PostToolUse"), None);
    }

    #[test]
    fn tool_use_wait_transitions_are_detected_from_tool_name() {
        assert_eq!(
            transition_for_claude_event(
                "PreToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::WaitingForUser,
                wait_reason: Some(TaskRunWaitReason::AskUserQuestion),
            })
        );
        assert_eq!(
            transition_for_claude_event("PreToolUse", Some(&json!({"tool_name": "ExitPlanMode"})))
                .unwrap()
                .wait_reason,
            Some(TaskRunWaitReason::ExitPlanMode)
        );
        assert!(
            transition_for_claude_event("PreToolUse", Some(&json!({"tool_name": "Read"})))
                .is_none()
        );
        assert_eq!(
            transition_for_claude_event(
                "PostToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::Running,
                wait_reason: None,
            })
        );
        assert!(
            transition_for_claude_event("PostToolUse", Some(&json!({"tool_name": "Read"})))
                .is_none()
        );
    }

    #[test]
    fn protected_transitions_cover_late_hooks() {
        assert!(transition_is_protected(
            TaskRunStatus::Failed,
            TaskRunStatus::Running
        ));
        assert!(transition_is_protected(
            TaskRunStatus::Failed,
            TaskRunStatus::Stopped
        ));
        assert!(transition_is_protected(
            TaskRunStatus::WaitingForUser,
            TaskRunStatus::Stopped
        ));
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            TaskRunStatus::Running
        ));
    }

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
