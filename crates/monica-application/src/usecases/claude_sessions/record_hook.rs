use anyhow::Result;

use monica_domain::{AgentSignal, ClaudeConversationStatus, SignalKind, TaskRunWaitReason};

use crate::ports::{ClaudeSessionObservation, ClaudeSessionRepository};

/// What one Claude-session hook ingestion did, for the CLI's debug log.
#[derive(Debug, Clone, Default)]
pub struct ClaudeHookReport {
    pub event_name: Option<String>,
    /// The signal decoded to nothing actionable (a dropped non-blocking tool call).
    pub ignored: bool,
    /// The `MONICA_CLAUDE_SESSION_ID` matched a `claude_sessions` row.
    pub session_found: bool,
    pub conversation_status: Option<ClaudeConversationStatus>,
    pub session_ended: bool,
}

/// The canonical event-log kind for a signal, provider-agnostic — the drain matches on
/// these instead of provider event names.
pub(crate) fn signal_kind_label(kind: &SignalKind) -> &'static str {
    match kind {
        SignalKind::SessionStarted { .. } => "session_started",
        SignalKind::PromptSubmitted => "prompt_submitted",
        SignalKind::UserInputRequired { .. } => "user_input_required",
        SignalKind::UserInputResolved => "user_input_resolved",
        SignalKind::TurnCompleted { .. } => "turn_completed",
        SignalKind::SubagentFinished { .. } => "subagent_finished",
        SignalKind::SessionEnded { .. } => "session_ended",
        SignalKind::NotificationReceived {
            permission_request: true,
        } => "permission_request",
        SignalKind::NotificationReceived {
            permission_request: false,
        } => "notification",
        SignalKind::Inert => "inert",
    }
}

/// Labels whose signals never change the session state (`observation_for` returns
/// `None`). The drain skips the state re-broadcast for batches containing only these:
/// re-emitting an unchanged Idle between turns reads as a fresh "turn over" to
/// subscribers.
pub(crate) fn label_is_state_neutral(kind: &str) -> bool {
    matches!(kind, "notification" | "inert")
}

/// A `/clear` ends the provider session but not the mapping: Claude keeps running in the
/// same PTY under a new session id, and the mapping's `ended` state is an irreversible
/// tombstone that recovery refuses forever.
fn is_clear(reason: Option<&str>) -> bool {
    reason == Some("clear")
}

/// How a signal moves the conversation state machine (idle / thinking / awaiting_user /
/// ended-via-status). `None` means "record the event, change nothing". Pure — the store
/// applies the result atomically with the event insert. Never touches pending → active:
/// that confirmation belongs to the open flow.
pub(crate) fn observation_for(kind: &SignalKind) -> Option<ClaudeSessionObservation<'static>> {
    let conversation = |status| ClaudeSessionObservation {
        conversation_status: Some(status),
        wait_reason: Some(None),
        ..Default::default()
    };
    match kind {
        SignalKind::SessionStarted { .. } => Some(ClaudeSessionObservation {
            subagents_running: Some(false),
            ..conversation(ClaudeConversationStatus::Idle)
        }),
        SignalKind::PromptSubmitted | SignalKind::UserInputResolved => {
            Some(conversation(ClaudeConversationStatus::Thinking))
        }
        SignalKind::UserInputRequired { reason, .. } => Some(ClaudeSessionObservation {
            conversation_status: Some(ClaudeConversationStatus::AwaitingUser),
            wait_reason: Some(Some(*reason)),
            ..Default::default()
        }),
        // A turn that leaves subagents running is not the end of the logical turn:
        // Claude auto-continues once they finish, and that continuation's TurnCompleted
        // (subagents_running: false) is the single Idle transition. Flipping to Idle here
        // would surface a false "turn over" to subscribers mid-subagent. If the Stop
        // snapshot was stale (a subagent already stopped) the continuation turn's fresh
        // snapshot corrects it; if no continuation ever fires, interrupt_claude_session
        // is the recovery.
        SignalKind::TurnCompleted { subagents_running: true } => Some(ClaudeSessionObservation {
            subagents_running: Some(true),
            ..Default::default()
        }),
        SignalKind::TurnCompleted { subagents_running: false } => Some(ClaudeSessionObservation {
            subagents_running: Some(false),
            ..conversation(ClaudeConversationStatus::Idle)
        }),
        SignalKind::SessionEnded { reason } if is_clear(reason.as_deref()) => {
            Some(ClaudeSessionObservation {
                subagents_running: Some(false),
                ..conversation(ClaudeConversationStatus::Idle)
            })
        }
        SignalKind::SessionEnded { .. } => Some(ClaudeSessionObservation {
            mark_ended: true,
            ..conversation(ClaudeConversationStatus::Idle)
        }),
        SignalKind::NotificationReceived {
            permission_request: true,
        } => Some(ClaudeSessionObservation {
            conversation_status: Some(ClaudeConversationStatus::AwaitingUser),
            wait_reason: Some(Some(TaskRunWaitReason::PermissionRequest)),
            ..Default::default()
        }),
        SignalKind::SubagentFinished { subagents_running } => Some(ClaudeSessionObservation {
            subagents_running: Some(*subagents_running),
            ..Default::default()
        }),
        SignalKind::NotificationReceived {
            permission_request: false,
        }
        | SignalKind::Inert => None,
    }
}

/// Record one hook for a Claude Runtime session: event row + conversation-state update in
/// a single store transaction. The caller has already decoded `raw_stdin` into `signal`;
/// `None` (a dropped non-blocking tool call) touches nothing.
pub fn record_claude_session_hook<R: ClaudeSessionRepository>(
    repos: &mut R,
    claude_session_id: &str,
    signal: Option<&AgentSignal>,
    raw_stdin: &str,
) -> Result<ClaudeHookReport> {
    let Some(signal) = signal else {
        return Ok(ClaudeHookReport {
            ignored: true,
            ..Default::default()
        });
    };
    let mut observation = observation_for(&signal.kind).unwrap_or_default();
    observation.provider_session_id = signal.session_id.as_deref();
    let updated = repos.record_claude_session_signal(
        claude_session_id,
        signal_kind_label(&signal.kind),
        raw_stdin.trim(),
        observation,
    )?;
    Ok(ClaudeHookReport {
        event_name: signal.event_label.clone(),
        ignored: false,
        session_found: updated.is_some(),
        conversation_status: updated.as_ref().map(|s| s.conversation_status),
        session_ended: updated.is_some_and(|s| {
            s.status == monica_domain::ClaudeSessionStatus::Ended
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_domain::Continuation;

    fn status_of(kind: SignalKind) -> Option<(Option<ClaudeConversationStatus>, bool)> {
        observation_for(&kind).map(|o| (o.conversation_status, o.mark_ended))
    }

    #[test]
    fn signal_kinds_map_to_conversation_states() {
        use ClaudeConversationStatus::*;
        assert_eq!(
            status_of(SignalKind::SessionStarted { continuation: Continuation::Fresh }),
            Some((Some(Idle), false))
        );
        assert_eq!(status_of(SignalKind::PromptSubmitted), Some((Some(Thinking), false)));
        assert_eq!(status_of(SignalKind::UserInputResolved), Some((Some(Thinking), false)));
        assert_eq!(
            status_of(SignalKind::TurnCompleted { subagents_running: false }),
            Some((Some(Idle), false))
        );
        assert_eq!(
            status_of(SignalKind::TurnCompleted { subagents_running: true }),
            Some((None, false))
        );
        assert_eq!(
            status_of(SignalKind::SubagentFinished { subagents_running: false }),
            Some((None, false))
        );
        assert_eq!(status_of(SignalKind::Inert), None);
    }

    #[test]
    fn turn_completed_carries_subagents_running() {
        let obs = observation_for(&SignalKind::TurnCompleted { subagents_running: true }).unwrap();
        assert_eq!(obs.subagents_running, Some(true));
        assert_eq!(obs.conversation_status, None);

        let obs = observation_for(&SignalKind::TurnCompleted { subagents_running: false }).unwrap();
        assert_eq!(obs.subagents_running, Some(false));
        assert_eq!(obs.conversation_status, Some(ClaudeConversationStatus::Idle));
    }

    #[test]
    fn turn_completed_with_subagents_keeps_conversation_status_and_wait_reason() {
        // The logical turn is still in flight: neither the status (Thinking) nor a
        // pending wait_reason may be disturbed until the continuation turn settles.
        let obs = observation_for(&SignalKind::TurnCompleted { subagents_running: true }).unwrap();
        assert_eq!(obs.conversation_status, None);
        assert_eq!(obs.wait_reason, None);
        assert!(!obs.mark_ended);
    }

    #[test]
    fn subagent_finished_carries_subagents_running_without_touching_conversation_status() {
        let obs =
            observation_for(&SignalKind::SubagentFinished { subagents_running: true }).unwrap();
        assert_eq!(obs.subagents_running, Some(true));
        assert_eq!(obs.conversation_status, None);

        let obs =
            observation_for(&SignalKind::SubagentFinished { subagents_running: false }).unwrap();
        assert_eq!(obs.subagents_running, Some(false));
        assert_eq!(obs.conversation_status, None);
    }

    #[test]
    fn session_started_clears_subagents_running() {
        let obs = observation_for(&SignalKind::SessionStarted {
            continuation: Continuation::Fresh,
        })
        .unwrap();
        assert_eq!(obs.subagents_running, Some(false));
    }

    #[test]
    fn user_input_required_carries_wait_reason() {
        for reason in TaskRunWaitReason::TOOL_WAITS {
            let observation = observation_for(&SignalKind::UserInputRequired {
                reason,
                plan_file_path: None,
            })
            .unwrap();
            assert_eq!(
                observation.conversation_status,
                Some(ClaudeConversationStatus::AwaitingUser)
            );
            assert_eq!(observation.wait_reason, Some(Some(reason)));
        }
    }

    #[test]
    fn permission_notification_awaits_user_but_idle_notification_does_not() {
        let permission = observation_for(&SignalKind::NotificationReceived {
            permission_request: true,
        })
        .unwrap();
        assert_eq!(
            permission.conversation_status,
            Some(ClaudeConversationStatus::AwaitingUser)
        );
        assert_eq!(
            permission.wait_reason,
            Some(Some(TaskRunWaitReason::PermissionRequest))
        );
        assert!(observation_for(&SignalKind::NotificationReceived {
            permission_request: false,
        })
        .is_none());
    }

    #[test]
    fn session_end_tombstones_except_on_clear() {
        // `/clear`: the tab lives on under a new provider session id; `ended` would brick it.
        let cleared = observation_for(&SignalKind::SessionEnded {
            reason: Some("clear".into()),
        })
        .unwrap();
        assert!(!cleared.mark_ended);
        assert_eq!(
            cleared.conversation_status,
            Some(ClaudeConversationStatus::Idle)
        );
        assert_eq!(cleared.subagents_running, Some(false));
        for reason in [None, Some("logout".to_string()), Some("prompt_input_exit".to_string())] {
            let ended = observation_for(&SignalKind::SessionEnded { reason }).unwrap();
            assert!(ended.mark_ended);
        }
    }

    #[test]
    fn every_kind_has_a_stable_event_log_label() {
        assert_eq!(
            signal_kind_label(&SignalKind::TurnCompleted { subagents_running: false }),
            "turn_completed"
        );
        assert_eq!(
            signal_kind_label(&SignalKind::SessionEnded { reason: None }),
            "session_ended"
        );
        assert_eq!(
            signal_kind_label(&SignalKind::NotificationReceived { permission_request: true }),
            "permission_request"
        );
        assert_eq!(
            signal_kind_label(&SignalKind::NotificationReceived { permission_request: false }),
            "notification"
        );
    }

    #[test]
    fn state_neutral_labels_match_observationless_kinds() {
        // Exactly the labels whose observation_for is None: a drift here either
        // re-introduces the stale-Idle re-broadcast or silences a real state change.
        assert!(label_is_state_neutral("notification"));
        assert!(label_is_state_neutral("inert"));
        for label in [
            "session_started",
            "prompt_submitted",
            "user_input_required",
            "user_input_resolved",
            "turn_completed",
            "subagent_finished",
            "session_ended",
            "permission_request",
        ] {
            assert!(!label_is_state_neutral(label), "{label} must re-broadcast state");
        }
    }
}
