//! Fan-out of Claude-session [`ApplicationEvent`]s to Agent Runtime `subscribe`
//! connections. [`TauriEventSink::emit`](crate::event_sink::TauriEventSink) publishes
//! every event here in addition to the webview, so anything any façade emits — the drain
//! worker, a Tauri command, a control-socket op — reaches socket subscribers with no
//! extra wiring.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use monica_agent_runtime_protocol::SessionEvent;
use monica_application::ApplicationEvent;
use monica_domain::{ClaudeConversationStatus, ClaudeSessionStatus};

/// Events buffered per subscriber before it is considered stuck. Generous relative to the
/// event rate (a handful per turn): only a subscriber that stopped reading fills it.
const SUBSCRIBER_BUFFER: usize = 256;

struct Subscriber {
    id: u64,
    claude_session_id: String,
    tx: SyncSender<SessionEvent>,
}

/// Registry of live `subscribe` connections. A subscriber whose buffer fills is dropped
/// (its channel disconnects and the serving thread closes the socket): an explicit EOF
/// tells the client it lagged, where silently discarding events would not.
#[derive(Default)]
pub struct ClaudeSessionBroadcaster {
    subs: Mutex<Vec<Subscriber>>,
    next_id: AtomicU64,
}

/// A live registration, removed from the registry on drop. The RAII cleanup is what
/// keeps the registry bounded: `publish` only prunes an entry when it has an event for
/// that session to fail to deliver, which never happens for a session that is already
/// ended or was never known — exactly the subscriptions that return early.
pub struct Subscription {
    rx: Receiver<SessionEvent>,
    id: u64,
    broadcaster: Arc<ClaudeSessionBroadcaster>,
}

impl Subscription {
    pub fn recv_timeout(&self, timeout: Duration) -> Result<SessionEvent, RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut subs = self.broadcaster.subs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        subs.retain(|sub| sub.id != self.id);
    }
}

impl ClaudeSessionBroadcaster {
    pub fn subscribe(self: &Arc<Self>, claude_session_id: &str) -> Subscription {
        let (tx, rx) = std::sync::mpsc::sync_channel(SUBSCRIBER_BUFFER);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut subs = self.subs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        subs.push(Subscriber { id, claude_session_id: claude_session_id.to_string(), tx });
        drop(subs);
        Subscription { rx, id, broadcaster: Arc::clone(self) }
    }

    pub fn publish(&self, event: &ApplicationEvent) {
        let Some((claude_session_id, events)) = session_events_for(event) else {
            return;
        };
        let mut subs = self.subs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        subs.retain(|sub| {
            if sub.claude_session_id != claude_session_id {
                return true;
            }
            for event in &events {
                match sub.tx.try_send(event.clone()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                        return false;
                    }
                }
            }
            true
        });
    }
}

pub(crate) fn events_for_transcript_records(
    records: &[monica_application::ClaudeTranscriptRecord],
) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    for record in records {
        let monica_application::ClaudeTranscriptRecordKind::Assistant { text, tool_uses } =
            &record.kind
        else {
            continue;
        };
        for tool_use in tool_uses {
            events.push(SessionEvent::ToolUse {
                tool_use_id: tool_use.id.clone(),
                name: tool_use.name.clone(),
                input_json: tool_use.input_json.clone(),
            });
        }
        if !text.is_empty() {
            events.push(SessionEvent::AssistantMessage { text: text.clone() });
        }
    }
    events
}

/// The wire events one [`ApplicationEvent`] translates to, at message granularity.
/// `Thinking` maps to nothing: the ack to `send_user_message` (or a human typing) is the
/// in-flight signal, and the stream only reports settled states.
fn session_events_for(event: &ApplicationEvent) -> Option<(String, Vec<SessionEvent>)> {
    match event {
        ApplicationEvent::ClaudeSessionStateChanged {
            claude_session_id,
            session_status,
            conversation_status,
            wait_reason,
            ..
        } => {
            let events = if *session_status == ClaudeSessionStatus::Ended {
                vec![SessionEvent::Ended]
            } else {
                match conversation_status {
                    ClaudeConversationStatus::Idle => vec![SessionEvent::Idle],
                    ClaudeConversationStatus::AwaitingUser => {
                        vec![SessionEvent::AwaitingUser {
                            wait_reason: wait_reason.as_ref().map(|r| r.as_str().to_string()),
                        }]
                    }
                    ClaudeConversationStatus::Thinking => Vec::new(),
                }
            };
            Some((claude_session_id.clone(), events))
        }
        ApplicationEvent::ClaudeSessionMessages { claude_session_id, records } => {
            Some((claude_session_id.clone(), events_for_transcript_records(records)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_application::{ClaudeToolUse, ClaudeTranscriptRecord, ClaudeTranscriptRecordKind};

    fn state_changed(
        session_status: ClaudeSessionStatus,
        conversation_status: ClaudeConversationStatus,
    ) -> ApplicationEvent {
        ApplicationEvent::ClaudeSessionStateChanged {
            claude_session_id: "cs-1".into(),
            tab_id: "tab-1".into(),
            session_status,
            conversation_status,
            wait_reason: None,
        }
    }

    fn assistant_record(text: &str, tool_uses: Vec<ClaudeToolUse>) -> ClaudeTranscriptRecord {
        ClaudeTranscriptRecord {
            uuid: None,
            timestamp: None,
            kind: ClaudeTranscriptRecordKind::Assistant { text: text.to_string(), tool_uses },
        }
    }

    #[test]
    fn maps_settled_states_and_swallows_thinking() {
        let (_, events) = session_events_for(&state_changed(
            ClaudeSessionStatus::Active,
            ClaudeConversationStatus::Idle,
        ))
        .unwrap();
        assert_eq!(events, vec![SessionEvent::Idle]);

        let (_, events) = session_events_for(&state_changed(
            ClaudeSessionStatus::Active,
            ClaudeConversationStatus::Thinking,
        ))
        .unwrap();
        assert!(events.is_empty());

        // An ended mapping wins over whatever the conversation last did.
        let (_, events) = session_events_for(&state_changed(
            ClaudeSessionStatus::Ended,
            ClaudeConversationStatus::Idle,
        ))
        .unwrap();
        assert_eq!(events, vec![SessionEvent::Ended]);
    }

    #[test]
    fn maps_awaiting_user_with_its_reason() {
        let event = ApplicationEvent::ClaudeSessionStateChanged {
            claude_session_id: "cs-1".into(),
            tab_id: "tab-1".into(),
            session_status: ClaudeSessionStatus::Active,
            conversation_status: ClaudeConversationStatus::AwaitingUser,
            wait_reason: Some(monica_domain::TaskRunWaitReason::AskUserQuestion),
        };
        let (_, events) = session_events_for(&event).unwrap();
        assert_eq!(
            events,
            vec![SessionEvent::AwaitingUser { wait_reason: Some("ask_user_question".into()) }]
        );
    }

    #[test]
    fn maps_assistant_records_to_tool_uses_then_text() {
        let event = ApplicationEvent::ClaudeSessionMessages {
            claude_session_id: "cs-1".into(),
            records: vec![
                assistant_record(
                    "answer",
                    vec![ClaudeToolUse {
                        id: "t-1".into(),
                        name: "Bash".into(),
                        input_json: "{}".into(),
                    }],
                ),
                ClaudeTranscriptRecord {
                    uuid: None,
                    timestamp: None,
                    kind: ClaudeTranscriptRecordKind::User,
                },
                assistant_record("", Vec::new()),
            ],
        };
        let (id, events) = session_events_for(&event).unwrap();
        assert_eq!(id, "cs-1");
        assert_eq!(
            events,
            vec![
                SessionEvent::ToolUse {
                    tool_use_id: "t-1".into(),
                    name: "Bash".into(),
                    input_json: "{}".into(),
                },
                SessionEvent::AssistantMessage { text: "answer".into() },
            ]
        );
    }

    #[test]
    fn unrelated_events_map_to_nothing() {
        let event = ApplicationEvent::PullRequestSyncCompleted { synced_count: 0 };
        assert!(session_events_for(&event).is_none());
    }

    #[test]
    fn publish_fans_out_only_to_matching_subscribers() {
        let broadcaster = Arc::new(ClaudeSessionBroadcaster::default());
        let sub_match = broadcaster.subscribe("cs-1");
        let sub_other = broadcaster.subscribe("cs-2");

        broadcaster
            .publish(&state_changed(ClaudeSessionStatus::Active, ClaudeConversationStatus::Idle));

        assert_eq!(sub_match.rx.try_recv().unwrap(), SessionEvent::Idle);
        assert!(sub_other.rx.try_recv().is_err());
    }

    #[test]
    fn publish_drops_a_full_subscriber_instead_of_discarding_silently() {
        let broadcaster = Arc::new(ClaudeSessionBroadcaster::default());
        let sub = broadcaster.subscribe("cs-1");
        let idle = state_changed(ClaudeSessionStatus::Active, ClaudeConversationStatus::Idle);
        for _ in 0..=SUBSCRIBER_BUFFER {
            broadcaster.publish(&idle);
        }

        // The overflowing publish removed the subscriber: draining the buffer ends in a
        // disconnect, never in a silent gap.
        let mut drained = 0;
        while sub.rx.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(drained, SUBSCRIBER_BUFFER);
        assert!(matches!(
            sub.rx.try_recv().unwrap_err(),
            std::sync::mpsc::TryRecvError::Disconnected
        ));
    }

    #[test]
    fn dropping_a_subscription_unregisters_it_without_needing_an_event() {
        // A subscription to a session that will never emit again (ended / never existed)
        // must not stay in the registry forever: publish would never prune it.
        let broadcaster = Arc::new(ClaudeSessionBroadcaster::default());
        let sub = broadcaster.subscribe("cs-never-again");
        assert_eq!(broadcaster.subs.lock().unwrap().len(), 1);

        drop(sub);

        assert!(broadcaster.subs.lock().unwrap().is_empty());
    }

    #[test]
    fn dropping_one_subscription_leaves_the_others_registered() {
        let broadcaster = Arc::new(ClaudeSessionBroadcaster::default());
        let first = broadcaster.subscribe("cs-1");
        let second = broadcaster.subscribe("cs-1");
        drop(first);

        broadcaster
            .publish(&state_changed(ClaudeSessionStatus::Active, ClaudeConversationStatus::Idle));

        assert_eq!(second.rx.try_recv().unwrap(), SessionEvent::Idle);
        assert_eq!(broadcaster.subs.lock().unwrap().len(), 1);
    }
}
