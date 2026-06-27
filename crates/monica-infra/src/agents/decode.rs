use anyhow::Result;
use serde_json::Value;

use monica_application::{
    Agent, AgentEventDecoder, AgentSignal, Continuation, SignalKind, TaskRunWaitReason,
};

/// Claude Code hook-event decoder: raw Claude hook payload → provider-agnostic [`AgentSignal`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ClaudeEventDecoder;

impl AgentEventDecoder for ClaudeEventDecoder {
    fn decode(&self, raw: &[u8]) -> Result<Option<AgentSignal>> {
        Ok(decode_signal(Agent::Claude, raw))
    }
}

/// Codex CLI hook-event decoder.
#[derive(Debug, Default, Clone, Copy)]
pub struct CodexEventDecoder;

impl AgentEventDecoder for CodexEventDecoder {
    fn decode(&self, raw: &[u8]) -> Result<Option<AgentSignal>> {
        Ok(decode_signal(Agent::Codex, raw))
    }
}

/// The [`AgentEventDecoder`] for `agent`. Drivers decode through the port so they stay decoupled
/// from the concrete per-agent decoders.
pub fn decoder_for(agent: Agent) -> &'static dyn AgentEventDecoder {
    match agent {
        Agent::Claude => &ClaudeEventDecoder,
        Agent::Codex => &CodexEventDecoder,
    }
}

/// The opaque provider event name, for logging an event the decoder declined to act on (e.g. a
/// dropped non-blocking tool call, where [`AgentEventDecoder::decode`] returns `None`). Provider
/// field knowledge stays in this module rather than leaking into the driver's log line.
pub fn event_label(raw: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(raw).ok()?.trim();
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn decode_signal(agent: Agent, raw: &[u8]) -> Option<AgentSignal> {
    let text = std::str::from_utf8(raw).ok()?.trim();
    let parsed: Value = serde_json::from_str(text).ok()?;
    let event_name = parsed.get("hook_event_name").and_then(Value::as_str);

    // Non-blocking tool calls (a Read, a Bash) are pure noise — never recorded.
    if matches!(event_name, Some("PreToolUse" | "PostToolUse")) && tool_wait_reason(&parsed).is_none()
    {
        return None;
    }

    let session_id = parsed
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(AgentSignal {
        session_id,
        event_label: event_name.map(str::to_string),
        kind: signal_kind(agent, event_name, &parsed),
    })
}

fn signal_kind(agent: Agent, event_name: Option<&str>, payload: &Value) -> SignalKind {
    match event_name {
        Some("SessionStart") => SignalKind::SessionStarted {
            continuation: continuation_of(payload),
        },
        Some("UserPromptSubmit") => SignalKind::PromptSubmitted,
        // The non-wait case is filtered out in `decode_signal`; the `None` arms are unreachable but
        // kept honest rather than papering over with a bogus wait reason.
        Some("PreToolUse") => match tool_wait_reason(payload) {
            Some(reason) => SignalKind::UserInputRequired {
                reason,
                plan_file_path: plan_file_path(payload),
            },
            None => SignalKind::Inert,
        },
        Some("PostToolUse") => match tool_wait_reason(payload) {
            Some(_) => SignalKind::UserInputResolved,
            None => SignalKind::Inert,
        },
        Some("Stop") => SignalKind::TurnCompleted {
            subagents_running: subagents_in_flight(payload, None),
        },
        Some("SubagentStop") => SignalKind::SubagentFinished {
            subagents_running: subagents_in_flight(payload, stopping_subagent_id(payload)),
        },
        Some("PermissionRequest") if agent == Agent::Codex => SignalKind::UserInputRequired {
            reason: TaskRunWaitReason::PermissionRequest,
            plan_file_path: None,
        },
        Some("SessionEnd") if agent == Agent::Claude => SignalKind::SessionEnded,
        _ => SignalKind::Inert,
    }
}

/// The tool-specific wait a `tool_name` implies, if it blocks on the user.
fn tool_wait_reason(payload: &Value) -> Option<TaskRunWaitReason> {
    match payload.get("tool_name").and_then(Value::as_str)? {
        "AskUserQuestion" => Some(TaskRunWaitReason::AskUserQuestion),
        "ExitPlanMode" => Some(TaskRunWaitReason::ExitPlanMode),
        _ => None,
    }
}

/// The plan file an `ExitPlanMode` payload points at (`tool_input.planFilePath`). `None` for any
/// other tool or a payload without (or with an empty) field, so a stored path is never clobbered.
fn plan_file_path(payload: &Value) -> Option<String> {
    if payload.get("tool_name").and_then(Value::as_str) != Some("ExitPlanMode") {
        return None;
    }
    payload
        .get("tool_input")
        .and_then(|input| input.get("planFilePath"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

fn continuation_of(payload: &Value) -> Continuation {
    match payload.get("source").and_then(Value::as_str) {
        Some("resume") => Continuation::Resume,
        Some("compact") => Continuation::Compact,
        _ => Continuation::Fresh,
    }
}

fn stopping_subagent_id(payload: &Value) -> Option<&str> {
    payload.get("agent_id").and_then(Value::as_str)
}

/// Whether any background subagent other than `stopping_id` is still running. `background_tasks` is
/// the parent session's authoritative pre-event snapshot, carried on every Stop/SubagentStop. A
/// SubagentStop still lists the agent that is stopping, so it is excluded by id; a Stop reads the
/// list as-is (`stopping_id = None`).
fn subagents_in_flight(payload: &Value, stopping_id: Option<&str>) -> bool {
    payload
        .get("background_tasks")
        .and_then(Value::as_array)
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task.get("status").and_then(Value::as_str) == Some("running")
                    && task.get("id").and_then(Value::as_str) != stopping_id
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode_claude(payload: Value) -> Option<AgentSignal> {
        decoder_for(Agent::Claude).decode(payload.to_string().as_bytes()).unwrap()
    }

    fn decode_codex(payload: Value) -> Option<AgentSignal> {
        decoder_for(Agent::Codex).decode(payload.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn unparseable_or_empty_yields_no_signal() {
        assert!(decoder_for(Agent::Claude).decode(b"not json").unwrap().is_none());
        assert!(decoder_for(Agent::Claude).decode(b"").unwrap().is_none());
    }

    #[test]
    fn event_label_recovers_the_name_of_a_dropped_event() {
        // A non-blocking tool call is dropped (no signal) but its label is still recoverable for
        // the driver's debug log.
        let raw = json!({"hook_event_name": "PreToolUse", "tool_name": "Read"}).to_string();
        assert!(decoder_for(Agent::Claude).decode(raw.as_bytes()).unwrap().is_none());
        assert_eq!(event_label(raw.as_bytes()).as_deref(), Some("PreToolUse"));
        assert_eq!(event_label(b"not json"), None);
    }

    #[test]
    fn non_wait_tool_use_is_dropped_for_all_agents() {
        for agent in [Agent::Claude, Agent::Codex] {
            for event in ["PreToolUse", "PostToolUse"] {
                let sig = decoder_for(agent)
                    .decode(
                        json!({"hook_event_name": event, "tool_name": "Read"})
                            .to_string()
                            .as_bytes(),
                    )
                    .unwrap();
                assert!(sig.is_none(), "{agent:?} {event}");
            }
        }
    }

    #[test]
    fn claude_lifecycle_events_map_to_signal_kinds() {
        let cases = [
            (
                "SessionStart",
                SignalKind::SessionStarted {
                    continuation: Continuation::Fresh,
                },
            ),
            ("UserPromptSubmit", SignalKind::PromptSubmitted),
            (
                "Stop",
                SignalKind::TurnCompleted {
                    subagents_running: false,
                },
            ),
            ("SessionEnd", SignalKind::SessionEnded),
            ("StopFailure", SignalKind::Inert),
            ("Notification", SignalKind::Inert),
            ("SubagentStart", SignalKind::Inert),
        ];
        for (event, expected) in cases {
            let sig = decode_claude(json!({"hook_event_name": event})).expect(event);
            assert_eq!(sig.kind, expected, "{event}");
            assert_eq!(sig.event_label.as_deref(), Some(event));
        }
    }

    #[test]
    fn tool_waits_are_detected_from_tool_name() {
        let ask = decode_claude(json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"}))
            .unwrap();
        assert_eq!(
            ask.kind,
            SignalKind::UserInputRequired {
                reason: TaskRunWaitReason::AskUserQuestion,
                plan_file_path: None,
            }
        );
        let resolved =
            decode_claude(json!({"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion"}))
                .unwrap();
        assert_eq!(resolved.kind, SignalKind::UserInputResolved);
    }

    #[test]
    fn exit_plan_mode_carries_plan_file_path() {
        let sig = decode_claude(json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "ExitPlanMode",
            "tool_input": { "planFilePath": "/p.md" }
        }))
        .unwrap();
        assert_eq!(
            sig.kind,
            SignalKind::UserInputRequired {
                reason: TaskRunWaitReason::ExitPlanMode,
                plan_file_path: Some("/p.md".into()),
            }
        );
        // Empty path is treated as absent.
        let empty = decode_claude(json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "ExitPlanMode",
            "tool_input": { "planFilePath": "" }
        }))
        .unwrap();
        assert_eq!(empty.plan_file_path(), None);
    }

    #[test]
    fn session_start_source_classifies_continuation() {
        for (source, expected) in [
            ("resume", Continuation::Resume),
            ("compact", Continuation::Compact),
            ("startup", Continuation::Fresh),
            ("clear", Continuation::Fresh),
        ] {
            let sig = decode_claude(json!({"hook_event_name": "SessionStart", "source": source}))
                .unwrap();
            assert_eq!(
                sig.kind,
                SignalKind::SessionStarted {
                    continuation: expected
                },
                "{source}"
            );
        }
    }

    #[test]
    fn stop_reads_all_background_tasks() {
        let busy = decode_claude(json!({
            "hook_event_name": "Stop",
            "background_tasks": [{"id": "a", "status": "completed"}, {"id": "b", "status": "running"}]
        }))
        .unwrap();
        assert_eq!(busy.kind, SignalKind::TurnCompleted { subagents_running: true });
        let idle = decode_claude(json!({"hook_event_name": "Stop", "background_tasks": []})).unwrap();
        assert_eq!(idle.kind, SignalKind::TurnCompleted { subagents_running: false });
    }

    #[test]
    fn subagent_stop_excludes_its_own_agent() {
        // Snapshot still lists the stopping agent; excluding it leaves nothing running.
        let last = decode_claude(json!({
            "hook_event_name": "SubagentStop",
            "agent_id": "b",
            "background_tasks": [{"id": "b", "status": "running"}]
        }))
        .unwrap();
        assert_eq!(last.kind, SignalKind::SubagentFinished { subagents_running: false });
        // A sibling still running keeps it in flight.
        let sibling = decode_claude(json!({
            "hook_event_name": "SubagentStop",
            "agent_id": "b",
            "background_tasks": [{"id": "b", "status": "running"}, {"id": "c", "status": "running"}]
        }))
        .unwrap();
        assert_eq!(sibling.kind, SignalKind::SubagentFinished { subagents_running: true });
        // A phantom SubagentStop (agent absent from snapshot) must not pretend the runner is gone.
        let phantom = decode_claude(json!({
            "hook_event_name": "SubagentStop",
            "agent_id": "ghost",
            "background_tasks": [{"id": "c", "status": "running"}]
        }))
        .unwrap();
        assert_eq!(phantom.kind, SignalKind::SubagentFinished { subagents_running: true });
    }

    #[test]
    fn session_id_is_extracted() {
        let sig = decode_claude(json!({"hook_event_name": "Stop", "session_id": "s1"})).unwrap();
        assert_eq!(sig.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn codex_permission_request_and_session_end_differ_from_claude() {
        let perm = decode_codex(json!({"hook_event_name": "PermissionRequest"})).unwrap();
        assert_eq!(
            perm.kind,
            SignalKind::UserInputRequired {
                reason: TaskRunWaitReason::PermissionRequest,
                plan_file_path: None,
            }
        );
        // Codex has no terminal SessionEnd, and compaction hooks are inert.
        assert_eq!(
            decode_codex(json!({"hook_event_name": "SessionEnd"})).unwrap().kind,
            SignalKind::Inert
        );
        for event in ["PreCompact", "PostCompact"] {
            assert_eq!(decode_codex(json!({"hook_event_name": event})).unwrap().kind, SignalKind::Inert);
        }
        // Claude does not act on a PermissionRequest (it never emits one).
        assert_eq!(
            decode_claude(json!({"hook_event_name": "PermissionRequest"})).unwrap().kind,
            SignalKind::Inert
        );
    }
}
