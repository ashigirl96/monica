use serde_json::Value;

use super::{TaskRunStatus, TaskRunWaitReason};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookTransition {
    pub status: TaskRunStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
}

pub fn wait_reason_for_tool(tool_name: &str) -> Option<TaskRunWaitReason> {
    match tool_name {
        "AskUserQuestion" => Some(TaskRunWaitReason::AskUserQuestion),
        "ExitPlanMode" => Some(TaskRunWaitReason::ExitPlanMode),
        _ => None,
    }
}

/// The generic "session is alive, type a prompt" wait that SessionStart and Stop both produce.
const AWAITING_PROMPT: HookTransition = HookTransition {
    status: TaskRunStatus::WaitingForUser,
    wait_reason: Some(TaskRunWaitReason::AwaitingPrompt),
};

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

    match event_name {
        // A fresh session has not run anything yet; the ball is in the user's court until the
        // first prompt lands. Stop means the turn finished — same court.
        "SessionStart" => Some(AWAITING_PROMPT),
        "Stop" => Some(AWAITING_PROMPT),
        "UserPromptSubmit" => Some(HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        }),
        "SessionEnd" => Some(HookTransition {
            status: TaskRunStatus::Stopped,
            wait_reason: None,
        }),
        "StopFailure" => Some(HookTransition {
            status: TaskRunStatus::Failed,
            wait_reason: None,
        }),
        _ => None,
    }
}

pub fn transition_is_generic_wait(next: HookTransition) -> bool {
    next == AWAITING_PROMPT
}

/// Protections against late or out-of-order hooks. This snapshot check is advisory (hooks run in
/// separate processes); the same rules are enforced atomically inside the store's UPDATE.
///
/// - Failed is sticky: a failure verdict must not be softened by trailing lifecycle events.
/// - A tool-specific wait (pending question / plan approval) must not be downgraded to the
///   generic awaiting-prompt wait by the Stop that trails every PreToolUse.
/// - A dead run stays dead: a Stop that lands after SessionEnd (or after terminal-exit
///   settlement) must not resurrect a stopped run into "needs you".
pub fn transition_is_protected(
    current_status: TaskRunStatus,
    current_wait_reason: Option<TaskRunWaitReason>,
    next: HookTransition,
) -> bool {
    if current_status == TaskRunStatus::Failed {
        return true;
    }
    if !transition_is_generic_wait(next) {
        return false;
    }
    match current_status {
        TaskRunStatus::Stopped => true,
        TaskRunStatus::WaitingForUser => {
            current_wait_reason.is_some_and(TaskRunWaitReason::is_tool_wait)
        }
        _ => false,
    }
}

/// Events that prove a user is actively driving a session in this shell. Only these may claim
/// or create runs; anything else (a stray `Stop` from an untracked session, a broken payload)
/// must never mutate the run set.
pub fn is_session_starting_event(event_name: Option<&str>) -> bool {
    matches!(event_name, Some("SessionStart" | "UserPromptSubmit"))
}

/// A resumed session's `SessionStart` still carries the *source* session's id — under
/// `--fork-session` the new id only appears on the first prompt. Letting it move bindings would
/// hand a fork the source run's tab, so tab claims wait for the first activity event, which
/// proves where the session actually lives.
pub fn is_resume_session_start(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    event_name == Some("SessionStart")
        && payload
            .and_then(|value| value.get("source"))
            .and_then(Value::as_str)
            == Some("resume")
}

/// A SessionStart that continues an existing conversation rather than opening a fresh one.
/// Both variants may resolve (via the carried session id) to a run that is mid-flight, so they
/// must not drive a status transition: a fork/resume start would demote a Running primary, and
/// auto-compact fires `source: "compact"` in the middle of a turn under the same session id.
pub fn is_continuation_session_start(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    event_name == Some("SessionStart")
        && matches!(
            payload
                .and_then(|value| value.get("source"))
                .and_then(Value::as_str),
            Some("resume" | "compact")
        )
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
    fn lifecycle_events_map_to_run_transitions() {
        let cases = [
            (
                "SessionStart",
                Some((
                    TaskRunStatus::WaitingForUser,
                    Some(TaskRunWaitReason::AwaitingPrompt),
                )),
            ),
            ("UserPromptSubmit", Some((TaskRunStatus::Running, None))),
            (
                "Stop",
                Some((
                    TaskRunStatus::WaitingForUser,
                    Some(TaskRunWaitReason::AwaitingPrompt),
                )),
            ),
            ("StopFailure", Some((TaskRunStatus::Failed, None))),
            ("SessionEnd", Some((TaskRunStatus::Stopped, None))),
            ("Notification", None),
        ];
        for (event, expected) in cases {
            assert_eq!(
                transition_for_claude_event(event, None).map(|t| (t.status, t.wait_reason)),
                expected,
                "{event}"
            );
        }
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
        let generic_wait = HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(TaskRunWaitReason::AwaitingPrompt),
        };
        let to_running = HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        };
        let to_stopped = HookTransition {
            status: TaskRunStatus::Stopped,
            wait_reason: None,
        };
        let to_question = HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(TaskRunWaitReason::AskUserQuestion),
        };

        // Failed is sticky against everything.
        for next in [generic_wait, to_running, to_stopped] {
            assert!(transition_is_protected(TaskRunStatus::Failed, None, next));
        }

        // A late Stop must not resurrect a dead run...
        assert!(transition_is_protected(
            TaskRunStatus::Stopped,
            None,
            generic_wait
        ));
        // ...but a real prompt revives it, and SessionEnd still lands.
        assert!(!transition_is_protected(
            TaskRunStatus::Stopped,
            None,
            to_running
        ));

        // The Stop trailing a PreToolUse must not erase the tool-specific wait...
        assert!(transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AskUserQuestion),
            generic_wait
        ));
        assert!(transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::ExitPlanMode),
            generic_wait
        ));
        // ...while a generic wait may be sharpened into a specific one, and a dead session
        // is allowed to settle a waiting run.
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AwaitingPrompt),
            to_question
        ));
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AwaitingPrompt),
            to_stopped
        ));
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AskUserQuestion),
            to_stopped
        ));

        // A generic wait re-asserting itself over a live run is unprotected.
        assert!(!transition_is_protected(
            TaskRunStatus::Running,
            None,
            generic_wait
        ));
    }

    #[test]
    fn resume_session_start_requires_both_event_and_source() {
        assert!(is_resume_session_start(
            Some("SessionStart"),
            Some(&json!({"source": "resume"}))
        ));
        assert!(!is_resume_session_start(
            Some("SessionStart"),
            Some(&json!({"source": "startup"}))
        ));
        assert!(!is_resume_session_start(
            Some("UserPromptSubmit"),
            Some(&json!({"source": "resume"}))
        ));
        assert!(!is_resume_session_start(Some("SessionStart"), None));
    }

    #[test]
    fn continuation_session_start_covers_resume_and_compact() {
        for source in ["resume", "compact"] {
            assert!(
                is_continuation_session_start(
                    Some("SessionStart"),
                    Some(&json!({"source": source}))
                ),
                "{source}"
            );
        }
        for source in ["startup", "clear"] {
            assert!(
                !is_continuation_session_start(
                    Some("SessionStart"),
                    Some(&json!({"source": source}))
                ),
                "{source}"
            );
        }
        assert!(!is_continuation_session_start(
            Some("UserPromptSubmit"),
            Some(&json!({"source": "resume"}))
        ));
        assert!(!is_continuation_session_start(Some("SessionStart"), None));
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
