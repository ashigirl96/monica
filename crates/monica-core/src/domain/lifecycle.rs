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

pub fn transition_is_generic_wait(next: HookTransition) -> bool {
    next == AWAITING_PROMPT
}

/// Whether any background subagent is still running once this event is accounted for.
///
/// `background_tasks` is the parent session's authoritative list of in-flight background work,
/// carried on every `Stop` and `SubagentStop`. It is a *pre-event* snapshot, so a `SubagentStop`
/// payload still lists the agent that is stopping — we exclude it by `agent_id`. Reading this list
/// directly is the single source of truth for the subagent guard: unlike a derived
/// `SubagentStart`/`SubagentStop` counter, it cannot drift when a hook is dropped or arrives
/// without its pair.
pub fn subagents_in_flight_after(event_name: Option<&str>, payload: Option<&Value>) -> bool {
    let stopping_id = if event_name == Some("SubagentStop") {
        payload
            .and_then(|value| value.get("agent_id"))
            .and_then(Value::as_str)
    } else {
        None
    };
    payload
        .and_then(|value| value.get("background_tasks"))
        .and_then(Value::as_array)
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task.get("status").and_then(Value::as_str) == Some("running")
                    && task.get("id").and_then(Value::as_str) != stopping_id
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
    // must not demote the run to "your turn". `subagent_in_flight` comes straight from the event's
    // `background_tasks` (see [`subagents_in_flight_after`]). `SessionStart` carries the same
    // generic wait but is new life, so it is exempt.
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

pub fn transition_for_event(
    agent: Agent,
    event_name: &str,
    payload: Option<&Value>,
) -> Option<HookTransition> {
    match event_name {
        "PreToolUse" => {
            let wait_reason = payload_tool_wait_reason(payload)?;
            Some(HookTransition {
                status: TaskRunStatus::WaitingForUser,
                wait_reason: Some(wait_reason),
            })
        }
        "PostToolUse" => {
            payload_tool_wait_reason(payload)?;
            Some(HookTransition {
                status: TaskRunStatus::Running,
                wait_reason: None,
            })
        }
        "SessionStart" | "Stop" => Some(AWAITING_PROMPT),
        "UserPromptSubmit" => Some(HookTransition {
            status: TaskRunStatus::Running,
            wait_reason: None,
        }),
        "PermissionRequest" if agent == Agent::Codex => Some(HookTransition {
            status: TaskRunStatus::WaitingForUser,
            wait_reason: Some(TaskRunWaitReason::PermissionRequest),
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
                transition_for_event(Agent::Claude,event, None).map(|t| (t.status, t.wait_reason)),
                expected,
                "{event}"
            );
        }
    }

    #[test]
    fn tool_use_wait_transitions_are_detected_from_tool_name() {
        assert_eq!(
            transition_for_event(Agent::Claude,
                "PreToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::WaitingForUser,
                wait_reason: Some(TaskRunWaitReason::AskUserQuestion),
            })
        );
        assert_eq!(
            transition_for_event(Agent::Claude,"PreToolUse", Some(&json!({"tool_name": "ExitPlanMode"})))
                .unwrap()
                .wait_reason,
            Some(TaskRunWaitReason::ExitPlanMode)
        );
        assert!(
            transition_for_event(Agent::Claude,"PreToolUse", Some(&json!({"tool_name": "Read"})))
                .is_none()
        );
        assert_eq!(
            transition_for_event(Agent::Claude,
                "PostToolUse",
                Some(&json!({"tool_name": "AskUserQuestion"}))
            ),
            Some(HookTransition {
                status: TaskRunStatus::Running,
                wait_reason: None,
            })
        );
        assert!(
            transition_for_event(Agent::Claude,"PostToolUse", Some(&json!({"tool_name": "Read"})))
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
    fn subagents_in_flight_reads_background_tasks_directly() {
        // A `Stop` reads the list as-is.
        assert!(subagents_in_flight_after(
            Some("Stop"),
            Some(&json!({"background_tasks": [
                {"id": "a", "status": "completed"},
                {"id": "b", "status": "running"}
            ]}))
        ));
        assert!(!subagents_in_flight_after(
            Some("Stop"),
            Some(&json!({"background_tasks": [{"id": "a", "status": "completed"}]}))
        ));
        assert!(!subagents_in_flight_after(Some("Stop"), Some(&json!({"background_tasks": []}))));
        // Absent or malformed → nothing in flight (no evidence to hold the run).
        assert!(!subagents_in_flight_after(Some("Stop"), Some(&json!({"background_tasks": "x"}))));
        assert!(!subagents_in_flight_after(Some("Stop"), None));
    }

    #[test]
    fn subagent_stop_excludes_its_own_agent_from_the_snapshot() {
        // The snapshot is taken before the stop is applied, so it still lists the stopping agent.
        let bg = json!({
            "agent_id": "b",
            "background_tasks": [{"id": "b", "status": "running"}]
        });
        // Excluding `b` leaves nothing running → not in flight, so the deferred stop may fire.
        assert!(!subagents_in_flight_after(Some("SubagentStop"), Some(&bg)));

        // A sibling still running keeps the run held.
        let bg_sibling = json!({
            "agent_id": "b",
            "background_tasks": [
                {"id": "b", "status": "running"},
                {"id": "c", "status": "running"}
            ]
        });
        assert!(subagents_in_flight_after(Some("SubagentStop"), Some(&bg_sibling)));

        // A start-less SubagentStop (its agent_id is absent from the snapshot) must not pretend the
        // still-running agent is gone.
        let bg_phantom = json!({
            "agent_id": "ghost",
            "background_tasks": [{"id": "c", "status": "running"}]
        });
        assert!(subagents_in_flight_after(Some("SubagentStop"), Some(&bg_phantom)));
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
            (
                "PermissionRequest",
                Some((
                    TaskRunStatus::WaitingForUser,
                    Some(TaskRunWaitReason::PermissionRequest),
                )),
            ),
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
