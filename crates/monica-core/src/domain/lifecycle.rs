use serde_json::Value;

use super::{Agent, TaskRunStatus, TaskRunWaitReason};

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

/// The tool-specific wait a `PreToolUse`/`PostToolUse` payload implies, if its `tool_name` is one
/// that blocks on the user. `None` means "not a wait tool" — the events that carry it are inert.
fn payload_tool_wait_reason(payload: Option<&Value>) -> Option<TaskRunWaitReason> {
    payload
        .and_then(|value| value.get("tool_name"))
        .and_then(Value::as_str)
        .and_then(wait_reason_for_tool)
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
        let wait_reason = payload_tool_wait_reason(payload)?;
        return Some(HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(wait_reason),
        });
    }
    if event_name == "PostToolUse" {
        payload_tool_wait_reason(payload)?;
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
        // StopFailure is an API-level turn error (rate limit, model_not_found, …): recoverable,
        // and it fires for subagents too under the parent's own session id — so it is never the
        // run's verdict. It stays logged for diagnostics but moves nothing; the only Failed left
        // is a prepare failure (claude was never launched), and a genuine death arrives as
        // SessionEnd / orphan settlement → Stopped.
        _ => None,
    }
}

pub fn transition_is_generic_wait(next: HookTransition) -> bool {
    next == AWAITING_PROMPT
}

/// How a hook event moves a run's `active_subagents` counter. Subagents (the Task tool) run
/// under the parent's session id, so the counter is per-run, not per-session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentCountUpdate {
    Increment,
    Decrement,
    Reset,
}

/// The counter mutation a hook event implies, or `None` when it leaves the count untouched.
///
/// A turn boundary (`UserPromptSubmit`, or a fresh `SessionStart`) resets to zero so a subagent
/// that died without a `SubagentStop` cannot strand the count above zero forever. Two look-alike
/// boundaries fire *mid-turn* while a subagent is still running and so are excluded — zeroing the
/// count there would let the trailing `Stop` flicker the run back to "your turn":
/// - a *continuation* `SessionStart` (`resume`/`compact`): auto-compact under the same session;
/// - a `<task-notification>` `UserPromptSubmit`: Claude re-injects each completed background
///   subagent's result as a `UserPromptSubmit`, but sibling subagents are still in flight.
pub fn subagent_count_update(
    event_name: &str,
    payload: Option<&Value>,
) -> Option<SubagentCountUpdate> {
    match event_name {
        "SubagentStart" => Some(SubagentCountUpdate::Increment),
        "SubagentStop" => Some(SubagentCountUpdate::Decrement),
        "UserPromptSubmit" if is_task_notification_prompt(payload) => None,
        "UserPromptSubmit" => Some(SubagentCountUpdate::Reset),
        "SessionStart" if !is_continuation_session_start(Some("SessionStart"), payload) => {
            Some(SubagentCountUpdate::Reset)
        }
        _ => None,
    }
}

/// Claude re-injects a completed background subagent's result into the parent as a
/// `UserPromptSubmit` whose prompt starts with `<task-notification>`. It looks like a turn
/// boundary but fires while sibling subagents are still running, so — like a continuation
/// `SessionStart` (see [`is_continuation_session_start`]) — it must not reset the subagent count.
pub fn is_task_notification_prompt(payload: Option<&Value>) -> bool {
    payload
        .and_then(|value| value.get("prompt"))
        .and_then(Value::as_str)
        .is_some_and(|prompt| prompt.trim_start().starts_with("<task-notification>"))
}

/// Whether a `Stop` payload reports background subagents still running. `background_tasks` is the
/// parent's own authoritative list (it carries only the still-running ones), so reading it backs
/// up the derived `active_subagents` counter: even if the counter is wrong, a `Stop` that arrives
/// while the parent says a subagent is in flight must not demote the run.
pub fn payload_has_running_subagents(payload: Option<&Value>) -> bool {
    payload
        .and_then(|value| value.get("background_tasks"))
        .and_then(Value::as_array)
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task.get("status").and_then(Value::as_str) == Some("running")
            })
        })
}

/// Protections against late or out-of-order hooks. This snapshot check is advisory (hooks run in
/// separate processes); the same rules are enforced atomically inside the store's UPDATE.
///
/// - A terminal verdict (SessionEnd → Stopped) belongs to the session that died: arriving from a
///   session that is not the run's current one, it is stale news and must not kill the live
///   successor that has since claimed the run.
/// - A tool-specific wait (pending question / plan approval) must not be downgraded to the
///   generic awaiting-prompt wait by the Stop that trails every PreToolUse.
/// - A dead run stays dead: a Stop that lands after SessionEnd (or after terminal-exit
///   settlement) must not resurrect a stopped run into "needs you".
///
/// The generic-wait rules are scoped to the session the run already saw: late stragglers by
/// definition come from that session (or arrive anonymous). A generic wait carried by a session
/// the run has never met — relaunching `claude` in the tab starts a fresh one — is new evidence
/// of life, so it may revive a stopped run, and it clears a tool wait whose question died with
/// its session.
pub fn transition_is_protected(
    current_status: TaskRunStatus,
    current_wait_reason: Option<TaskRunWaitReason>,
    known_session_id: Option<&str>,
    event_session_id: Option<&str>,
    subagent_in_flight: bool,
    event_name: Option<&str>,
    next: HookTransition,
) -> bool {
    if next.status.is_terminal() {
        return matches!(
            (known_session_id, event_session_id),
            (Some(known), Some(event)) if known != event
        );
    }
    if !transition_is_generic_wait(next) {
        return false;
    }
    // A `Stop` fires at the end of the parent's turn even while a subagent is still working; it
    // must not demote the run to "your turn". `subagent_in_flight` folds the `active_subagents`
    // counter together with the `Stop`'s own `background_tasks` (an authoritative backstop for a
    // counter zeroed mid-turn). `SessionStart` carries the same generic wait but is new life (and
    // resets the counter), so it is exempt.
    if subagent_in_flight && !is_session_starting_event(event_name) {
        return true;
    }
    let from_new_session = match (known_session_id, event_session_id) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(known), Some(event)) => known != event,
    };
    if from_new_session {
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

fn session_start_source<'a>(
    event_name: Option<&str>,
    payload: Option<&'a Value>,
) -> Option<&'a str> {
    if event_name != Some("SessionStart") {
        return None;
    }
    payload
        .and_then(|value| value.get("source"))
        .and_then(Value::as_str)
}

/// A resumed session's `SessionStart` still carries the *source* session's id — under
/// `--fork-session` the new id only appears on the first prompt. Letting it move bindings would
/// hand a fork the source run's tab, so tab claims wait for the first activity event, which
/// proves where the session actually lives.
pub fn is_resume_session_start(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    session_start_source(event_name, payload) == Some("resume")
}

/// A SessionStart that continues an existing conversation rather than opening a fresh one.
/// Both variants may resolve (via the carried session id) to a run that is mid-turn — a
/// fork/resume start would demote a Running primary, and auto-compact fires `source: "compact"`
/// in the middle of a turn under the same session id — so a Running run's transition is
/// suppressed for them.
pub fn is_continuation_session_start(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    matches!(
        session_start_source(event_name, payload),
        Some("resume" | "compact")
    )
}

pub fn should_ignore_claude_event(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    matches!(event_name, Some("PreToolUse" | "PostToolUse"))
        && payload_tool_wait_reason(payload).is_none()
}

pub fn transition_for_event(
    agent: Agent,
    event_name: &str,
    payload: Option<&Value>,
) -> Option<HookTransition> {
    if event_name == "PreToolUse" {
        let wait_reason = payload_tool_wait_reason(payload)?;
        return Some(HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(wait_reason),
        });
    }
    if event_name == "PostToolUse" {
        payload_tool_wait_reason(payload)?;
        return Some(HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        });
    }

    match event_name {
        "SessionStart" => Some(AWAITING_PROMPT),
        "Stop" => Some(AWAITING_PROMPT),
        "UserPromptSubmit" => Some(HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        }),
        "SessionEnd" if agent == Agent::Claude => Some(HookTransition {
            status: TaskRunStatus::Stopped,
            wait_reason: None,
        }),
        _ => None,
    }
}

pub fn should_ignore_event(
    _agent: Agent,
    event_name: Option<&str>,
    payload: Option<&Value>,
) -> bool {
    matches!(event_name, Some("PreToolUse" | "PostToolUse"))
        && payload_tool_wait_reason(payload).is_none()
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
            // StopFailure is a recoverable API error (and fires for subagents too): inert.
            ("StopFailure", None),
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
        let same = (Some("sess-1"), Some("sess-1"));

        // A late Stop from the dead session must not resurrect the run; an anonymous event is
        // treated the same way.
        for event_session in [Some("sess-1"), None] {
            assert!(transition_is_protected(
                TaskRunStatus::Stopped,
                None,
                Some("sess-1"),
                event_session,
                false,
                Some("Stop"),
                generic_wait
            ));
        }
        // A fresh session's SessionStart is new life: the relaunched run goes back to
        // "your turn". A real prompt revives it too.
        assert!(!transition_is_protected(
            TaskRunStatus::Stopped,
            None,
            Some("sess-1"),
            Some("sess-2"),
            false,
            Some("SessionStart"),
            generic_wait
        ));
        assert!(!transition_is_protected(
            TaskRunStatus::Stopped,
            None,
            Some("sess-1"),
            Some("sess-1"),
            false,
            Some("UserPromptSubmit"),
            to_running
        ));

        // The Stop trailing a PreToolUse must not erase the tool-specific wait...
        for reason in [
            TaskRunWaitReason::AskUserQuestion,
            TaskRunWaitReason::ExitPlanMode,
        ] {
            assert!(transition_is_protected(
                TaskRunStatus::WaitingForUser,
                Some(reason),
                same.0,
                same.1,
                false,
                Some("Stop"),
                generic_wait
            ));
        }
        // ...but a question dies with its session: a new session's start clears it.
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AskUserQuestion),
            Some("sess-1"),
            Some("sess-2"),
            false,
            Some("SessionStart"),
            generic_wait
        ));
        // A generic wait may be sharpened into a specific one, and a dead session is allowed
        // to settle a waiting run.
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AwaitingPrompt),
            same.0,
            same.1,
            false,
            Some("PreToolUse"),
            to_question
        ));
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AwaitingPrompt),
            same.0,
            same.1,
            false,
            Some("SessionEnd"),
            to_stopped
        ));
        assert!(!transition_is_protected(
            TaskRunStatus::WaitingForUser,
            Some(TaskRunWaitReason::AskUserQuestion),
            same.0,
            same.1,
            false,
            Some("SessionEnd"),
            to_stopped
        ));

        // A generic wait re-asserting itself over a live run is unprotected.
        assert!(!transition_is_protected(
            TaskRunStatus::Running,
            None,
            same.0,
            same.1,
            false,
            Some("Stop"),
            generic_wait
        ));

        // ...but while a subagent is in flight (whether the counter or the `Stop`'s own
        // `background_tasks` reports it), that same `Stop` is held: the run stays Running instead
        // of flickering to "your turn".
        assert!(transition_is_protected(
            TaskRunStatus::Running,
            None,
            same.0,
            same.1,
            true,
            Some("Stop"),
            generic_wait
        ));
        // A SessionStart carries the same generic wait but is new life, so an in-flight subagent
        // never holds it back.
        assert!(!transition_is_protected(
            TaskRunStatus::Running,
            None,
            same.0,
            same.1,
            true,
            Some("SessionStart"),
            generic_wait
        ));

        // A run that never recorded a session treats any session as new.
        assert!(!transition_is_protected(
            TaskRunStatus::Stopped,
            None,
            None,
            Some("sess-1"),
            false,
            Some("SessionStart"),
            generic_wait
        ));

        // A terminal verdict from a session the run has moved past is stale: a late SessionEnd
        // from dead sess-1 must not kill the run sess-2 now drives.
        for current in [TaskRunStatus::Running, TaskRunStatus::WaitingForUser] {
            assert!(transition_is_protected(
                current,
                None,
                Some("sess-2"),
                Some("sess-1"),
                false,
                Some("SessionEnd"),
                to_stopped
            ));
        }
        // The same verdict from the run's own session (or anonymous, or before any session was
        // recorded) still lands.
        for (known, event) in [
            (Some("sess-1"), Some("sess-1")),
            (Some("sess-1"), None),
            (None, Some("sess-1")),
        ] {
            assert!(!transition_is_protected(
                TaskRunStatus::Running,
                None,
                known,
                event,
                false,
                Some("SessionEnd"),
                to_stopped
            ));
        }
    }

    #[test]
    fn subagent_count_update_maps_events_to_counter_ops() {
        assert_eq!(
            subagent_count_update("SubagentStart", None),
            Some(SubagentCountUpdate::Increment)
        );
        assert_eq!(
            subagent_count_update("SubagentStop", None),
            Some(SubagentCountUpdate::Decrement)
        );
        assert_eq!(
            subagent_count_update("UserPromptSubmit", None),
            Some(SubagentCountUpdate::Reset)
        );
        // A real prompt is a turn boundary and resets; a `<task-notification>` re-injection fires
        // mid-turn while sibling subagents run, so it must leave the count alone.
        assert_eq!(
            subagent_count_update(
                "UserPromptSubmit",
                Some(&json!({"prompt": "do the thing"}))
            ),
            Some(SubagentCountUpdate::Reset)
        );
        assert_eq!(
            subagent_count_update(
                "UserPromptSubmit",
                Some(&json!({"prompt": "<task-notification>\n<task-id>abc</task-id>"}))
            ),
            None
        );
        // A fresh session start (or a source-less one) resets; a mid-turn continuation must not.
        assert_eq!(
            subagent_count_update("SessionStart", Some(&json!({"source": "startup"}))),
            Some(SubagentCountUpdate::Reset)
        );
        assert_eq!(subagent_count_update("SessionStart", None), Some(SubagentCountUpdate::Reset));
        for source in ["resume", "compact"] {
            assert_eq!(
                subagent_count_update("SessionStart", Some(&json!({"source": source}))),
                None,
                "{source}"
            );
        }
        assert_eq!(subagent_count_update("Stop", None), None);
        assert_eq!(subagent_count_update("Notification", None), None);
    }

    #[test]
    fn task_notification_prompt_detected_by_prefix() {
        assert!(is_task_notification_prompt(Some(&json!({
            "prompt": "<task-notification>\n<task-id>abc</task-id>"
        }))));
        // Leading whitespace before the marker is still a re-injection.
        assert!(is_task_notification_prompt(Some(&json!({
            "prompt": "\n  <task-notification>"
        }))));
        assert!(!is_task_notification_prompt(Some(&json!({
            "prompt": "please <task-notification> later"
        }))));
        assert!(!is_task_notification_prompt(Some(&json!({"prompt": "do the thing"}))));
        assert!(!is_task_notification_prompt(Some(&json!({"other": "x"}))));
        assert!(!is_task_notification_prompt(None));
    }

    #[test]
    fn running_subagents_read_from_background_tasks() {
        assert!(payload_has_running_subagents(Some(&json!({
            "background_tasks": [
                {"id": "a", "status": "completed"},
                {"id": "b", "status": "running"}
            ]
        }))));
        assert!(!payload_has_running_subagents(Some(&json!({
            "background_tasks": [{"id": "a", "status": "completed"}]
        }))));
        assert!(!payload_has_running_subagents(Some(&json!({"background_tasks": []}))));
        assert!(!payload_has_running_subagents(Some(&json!({"background_tasks": "nope"}))));
        assert!(!payload_has_running_subagents(Some(&json!({"other": "x"}))));
        assert!(!payload_has_running_subagents(None));
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

    #[test]
    fn codex_lifecycle_events_map_to_run_transitions() {
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
            ("PermissionRequest", None),
            ("PreCompact", None),
            ("PostCompact", None),
        ];
        for (event, expected) in cases {
            assert_eq!(
                transition_for_event(Agent::Codex, event, None).map(|t| (t.status, t.wait_reason)),
                expected,
                "{event}"
            );
        }
    }

    #[test]
    fn codex_tool_use_wait_transitions() {
        assert_eq!(
            transition_for_event(
                Agent::Codex,
                "PreToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::WaitingForUser,
                wait_reason: Some(TaskRunWaitReason::AskUserQuestion),
            })
        );
        assert!(
            transition_for_event(Agent::Codex, "PreToolUse", Some(&json!({"tool_name": "Read"}))).is_none()
        );
        assert_eq!(
            transition_for_event(
                Agent::Codex,
                "PostToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::Running,
                wait_reason: None,
            })
        );
    }

    #[test]
    fn codex_has_no_session_end_transition() {
        assert!(transition_for_event(Agent::Codex, "SessionEnd", None).is_none());
    }

    #[test]
    fn should_ignore_event_filters_non_wait_tool_use_for_all_agents() {
        for agent in [Agent::Claude, Agent::Codex] {
            assert!(should_ignore_event(
                agent,
                Some("PreToolUse"),
                Some(&json!({"tool_name": "Read"}))
            ));
            assert!(!should_ignore_event(
                agent,
                Some("PreToolUse"),
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ));
            assert!(!should_ignore_event(agent, Some("SessionStart"), None));
        }
    }

    #[test]
    fn session_end_only_transitions_for_claude() {
        assert_eq!(
            transition_for_event(Agent::Claude, "SessionEnd", None),
            Some(HookTransition {
                status: TaskRunStatus::Stopped,
                wait_reason: None,
            })
        );
        assert!(transition_for_event(Agent::Codex, "SessionEnd", None).is_none());
    }
}
