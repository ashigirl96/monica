//! NDJSON wire protocol between external Agent Runtime clients (`monica-claude-sdk`) and the desktop
//! app's Agent Runtime control socket (`<base>/agent-runtime.sock`): one JSON object per line over a Unix domain
//! socket. Every op is one request/response pair per connection, except `subscribe`,
//! which keeps its connection open and streams response lines (`event` / `ping`) until
//! the session ends or either side disconnects.
//!
//! This is the Rust-client half of the external IPC surface; browser clients get a separate
//! localhost WebSocket in MVP7.

use serde::{Deserialize, Serialize};

/// Bump on any incompatible wire change — semantic contracts included, not just shape.
/// The server rejects a mismatched version with an `Err` response before doing anything,
/// so version skew fails with no side effect.
///
/// v2: `OpenClaudeSession.claude_session_id` is required and the server must honor it
/// (idempotent opens). v1 servers ignored the field and minted their own id, so a v2
/// client's "safe retry" against a v1 server would have opened a second session — the
/// bump makes v1 servers reject the request before launching instead.
///
/// v3: session-driving ops (`send_user_message` / `interrupt_session` / `list_sessions` /
/// `subscribe`) and their response shapes (`ack` / `sessions` / `event` / `ping`,
/// `Err.code`). A v2 server would answer any of them with an opaque parse error, so the
/// bump turns that into a clean version mismatch instead.
///
/// v4: terminal-session sync op for external clients that attach to ptyd with their own
/// connection and need the application facade to reconcile durable status from daemon truth.
pub const PROTOCOL_VERSION: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeRequest {
    pub version: u32,
    #[serde(flatten)]
    pub op: RuntimeRequestOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RuntimeRequestOp {
    OpenClaudeSession {
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        title: Option<String>,
        /// Idempotency key, REQUIRED in v2 (the server rejects requests without it
        /// before creating anything): opening with an id that is already mapped to a
        /// live session returns that session instead of creating a second one, so a
        /// retry after a lost response is safe — and because the client minted the key,
        /// it survives any lost response. `Option` only so a v1-era line still parses
        /// far enough to be answered with a version-mismatch error. v1 servers ignored
        /// the field, which is why the version bump — not the echoed id in the response
        /// — is what protects retries against them.
        #[serde(default)]
        claude_session_id: Option<String>,
    },
    /// Submit a user prompt to an idle session. Not idempotent: a retry after a lost
    /// response may submit the prompt twice, so clients must not auto-retry. The server
    /// answers `Busy` while a message is in flight (one in-flight message per session).
    SendUserMessage { claude_session_id: String, text: String },
    /// Send ESC to the session's PTY to stop the current turn.
    InterruptSession { claude_session_id: String },
    ListSessions,
    /// Switch this connection into a long-lived event stream for one session: the server
    /// answers `ack`, then writes `event` lines (and `ping` heartbeats) until the session
    /// ends or the connection drops.
    Subscribe { claude_session_id: String },
    /// Reconcile one terminal session's durable status from ptyd's global live view.
    /// External clients call this after they attach/detach on their own ptyd connection,
    /// avoiding the desktop app's shared ptyd connection as an attachment lease.
    SyncTerminalSession { terminal_session_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeResponse {
    Ok {
        session: ClaudeSessionInfo,
    },
    /// The op was carried out (send/interrupt), or the subscription is established
    /// (first line of a `subscribe` stream).
    Ack,
    Sessions {
        sessions: Vec<ClaudeSessionSummary>,
    },
    Event {
        claude_session_id: String,
        event: SessionEvent,
    },
    /// Subscribe-stream heartbeat. Carries no information; its purpose is the write
    /// itself, which lets the server detect a disconnected subscriber as a failed write.
    Ping,
    Err {
        error: String,
        /// The server could not determine the outcome either (e.g. the id maps to a
        /// launch reservation that is still unconfirmed, or liveness could not be
        /// verified): a session may exist under the requested id, so the client must
        /// retry with the same id, never a fresh one. `false` — the default, so
        /// determinate errors parse unchanged — proves no session was left behind.
        #[serde(default)]
        indeterminate: bool,
        /// Machine-readable classification for errors a client is expected to branch on
        /// (`busy` → wait and retry, `session_ended` → stop). `None` — the default, so
        /// v2-era error lines parse unchanged — means "unclassified".
        #[serde(default)]
        code: Option<RuntimeErrorCode>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeErrorCode {
    /// A message is already in flight (or the session is still launching); retry later.
    Busy,
    NotFound,
    SessionEnded,
}

/// One session-level occurrence on a `subscribe` stream, at message granularity.
/// Deliberately no `Thinking` variant: the `ack` to `send_user_message` is the in-flight
/// notification. Raw terminal output is out of scope (MVP5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    AssistantMessage {
        text: String,
    },
    ToolUse {
        tool_use_id: String,
        name: String,
        input_json: String,
    },
    AwaitingUser {
        #[serde(default)]
        wait_reason: Option<String>,
    },
    Idle,
    Ended,
}

/// One row of `list_sessions`. Status fields are the domain enums' snake_case strings,
/// kept as plain strings here so this crate stays dependency-free.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSessionSummary {
    pub claude_session_id: String,
    pub tab_id: String,
    pub terminal_session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub name: Option<String>,
    pub session_status: String,
    pub conversation_status: String,
    #[serde(default)]
    pub wait_reason: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub stuck_launching: bool,
}

/// The created session as the app reports it back to the Agent Runtime client. `claude_session_id`
/// is the pre-minted UUID Claude runs under, so the transcript path
/// (`~/.claude/projects/<slug>/<uuid>.jsonl`) is known before Claude finishes starting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSessionInfo {
    pub runspace_id: String,
    pub tab_id: String,
    pub session_id: String,
    pub claude_session_id: String,
    pub cwd: String,
    pub initial_command: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Absolute transcript path, resolved server-side so the slug derivation stays in one
    /// place.
    pub jsonl_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip_request(req: &RuntimeRequest) -> RuntimeRequest {
        let line = serde_json::to_string(req).unwrap();
        assert!(!line.contains('\n'), "wire format must stay one line");
        serde_json::from_str(&line).unwrap()
    }

    fn round_trip_response(res: &RuntimeResponse) -> RuntimeResponse {
        let line = serde_json::to_string(res).unwrap();
        assert!(!line.contains('\n'));
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn request_round_trips_through_ndjson() {
        let req = RuntimeRequest {
            version: PROTOCOL_VERSION,
            op: RuntimeRequestOp::OpenClaudeSession {
                cwd: "/tmp".into(),
                model: Some("opus".into()),
                title: None,
                claude_session_id: Some("5e0f5b0e-9f5c-4a4e-9d6e-000000000000".into()),
            },
        };
        let back = round_trip_request(&req);
        assert_eq!(back.version, PROTOCOL_VERSION);
        let RuntimeRequestOp::OpenClaudeSession { cwd, model, title, claude_session_id } = back.op
        else {
            panic!("expected open_claude_session");
        };
        assert_eq!(cwd, "/tmp");
        assert_eq!(model.as_deref(), Some("opus"));
        assert_eq!(title, None);
        assert_eq!(
            claude_session_id.as_deref(),
            Some("5e0f5b0e-9f5c-4a4e-9d6e-000000000000")
        );
    }

    #[test]
    fn optional_fields_may_be_omitted_on_the_wire() {
        // A v1 request written before claude_session_id existed must still parse (fields
        // default), so the server can answer it with a version-mismatch error instead of
        // an opaque parse error.
        let back: RuntimeRequest =
            serde_json::from_str(r#"{"version":1,"op":"open_claude_session","cwd":"/tmp"}"#).unwrap();
        let RuntimeRequestOp::OpenClaudeSession { cwd, model, title, claude_session_id } = back.op
        else {
            panic!("expected open_claude_session");
        };
        assert_eq!(cwd, "/tmp");
        assert_eq!(model, None);
        assert_eq!(title, None);
        assert_eq!(claude_session_id, None);
    }

    #[test]
    fn responses_round_trip() {
        let ok = RuntimeResponse::Ok {
            session: ClaudeSessionInfo {
                runspace_id: "agent-runtime".into(),
                tab_id: "tab-1".into(),
                session_id: "ts-1".into(),
                claude_session_id: "5e0f5b0e-9f5c-4a4e-9d6e-000000000000".into(),
                cwd: "/tmp".into(),
                initial_command: "claude --session-id x".into(),
                title: Some("t".into()),
                jsonl_path: "/Users/me/.claude/projects/-tmp/u.jsonl".into(),
            },
        };
        match round_trip_response(&ok) {
            RuntimeResponse::Ok { session } => {
                assert_eq!(session.runspace_id, "agent-runtime");
                assert_eq!(session.session_id, "ts-1");
                assert_eq!(session.title.as_deref(), Some("t"));
            }
            other => panic!("unexpected response: {other:?}"),
        }

        let err =
            RuntimeResponse::Err { error: "nope".into(), indeterminate: false, code: None };
        match round_trip_response(&err) {
            RuntimeResponse::Err { error, indeterminate, code } => {
                assert_eq!(error, "nope");
                assert!(!indeterminate);
                assert_eq!(code, None);
            }
            other => panic!("unexpected response: {other:?}"),
        }

        let unresolved = RuntimeResponse::Err {
            error: "unconfirmed".into(),
            indeterminate: true,
            code: None,
        };
        match round_trip_response(&unresolved) {
            RuntimeResponse::Err { indeterminate, .. } => assert!(indeterminate),
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn err_without_the_indeterminate_field_parses_as_determinate() {
        // A v1-era error line carries no flag; it must keep meaning "nothing was created".
        let back: RuntimeResponse = serde_json::from_str(r#"{"type":"err","error":"nope"}"#).unwrap();
        match back {
            RuntimeResponse::Err { indeterminate, code, .. } => {
                assert!(!indeterminate);
                assert_eq!(code, None);
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn session_ops_round_trip() {
        let ops = [
            RuntimeRequestOp::SendUserMessage {
                claude_session_id: "u-1".into(),
                text: "今日の日付を教えて".into(),
            },
            RuntimeRequestOp::InterruptSession { claude_session_id: "u-1".into() },
            RuntimeRequestOp::ListSessions,
            RuntimeRequestOp::Subscribe { claude_session_id: "u-1".into() },
            RuntimeRequestOp::SyncTerminalSession { terminal_session_id: "ts-1".into() },
        ];
        for op in ops {
            let back =
                round_trip_request(&RuntimeRequest { version: PROTOCOL_VERSION, op: op.clone() });
            assert_eq!(
                serde_json::to_value(&back.op).unwrap(),
                serde_json::to_value(&op).unwrap()
            );
        }
    }

    #[test]
    fn stream_responses_round_trip() {
        for res in [
            RuntimeResponse::Ack,
            RuntimeResponse::Ping,
            RuntimeResponse::Event {
                claude_session_id: "u-1".into(),
                event: SessionEvent::AssistantMessage { text: "line1\nline2".into() },
            },
            RuntimeResponse::Event {
                claude_session_id: "u-1".into(),
                event: SessionEvent::ToolUse {
                    tool_use_id: "t-1".into(),
                    name: "Bash".into(),
                    input_json: r#"{"command":"date"}"#.into(),
                },
            },
            RuntimeResponse::Event {
                claude_session_id: "u-1".into(),
                event: SessionEvent::AwaitingUser { wait_reason: Some("permission".into()) },
            },
            RuntimeResponse::Event { claude_session_id: "u-1".into(), event: SessionEvent::Idle },
            RuntimeResponse::Event { claude_session_id: "u-1".into(), event: SessionEvent::Ended },
        ] {
            let back = round_trip_response(&res);
            assert_eq!(
                serde_json::to_value(&back).unwrap(),
                serde_json::to_value(&res).unwrap()
            );
        }
    }

    #[test]
    fn sessions_response_round_trips_with_optional_fields_omitted() {
        let res = RuntimeResponse::Sessions {
            sessions: vec![ClaudeSessionSummary {
                claude_session_id: "u-1".into(),
                tab_id: "tab-1".into(),
                terminal_session_id: "ts-1".into(),
                cwd: "/tmp".into(),
                name: None,
                session_status: "active".into(),
                conversation_status: "idle".into(),
                wait_reason: None,
                created_at: "2026-07-06T00:00:00Z".into(),
                ended_at: None,
                stuck_launching: false,
            }],
        };
        let RuntimeResponse::Sessions { sessions } = round_trip_response(&res) else {
            panic!("expected sessions");
        };
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].claude_session_id, "u-1");
        assert_eq!(sessions[0].session_status, "active");
        assert_eq!(sessions[0].name, None);
        assert!(!sessions[0].stuck_launching);
    }

    #[test]
    fn summary_without_stuck_launching_field_deserializes_as_false() {
        let json = r#"{"claude_session_id":"u-1","tab_id":"t","terminal_session_id":"ts","cwd":"/","session_status":"active","conversation_status":"idle","created_at":"2026-01-01T00:00:00Z"}"#;
        let s: ClaudeSessionSummary = serde_json::from_str(json).unwrap();
        assert!(!s.stuck_launching);
    }

    #[test]
    fn summary_with_stuck_launching_true_round_trips() {
        let json = r#"{"claude_session_id":"u-1","tab_id":"t","terminal_session_id":"ts","cwd":"/","session_status":"active","conversation_status":"idle","created_at":"2026-01-01T00:00:00Z","stuck_launching":true}"#;
        let s: ClaudeSessionSummary = serde_json::from_str(json).unwrap();
        assert!(s.stuck_launching);
    }

    #[test]
    fn busy_error_code_round_trips_and_reads_as_snake_case() {
        let err = RuntimeResponse::Err {
            error: "a message is already in flight".into(),
            indeterminate: false,
            code: Some(RuntimeErrorCode::Busy),
        };
        let line = serde_json::to_string(&err).unwrap();
        assert!(line.contains(r#""code":"busy""#), "got: {line}");
        match round_trip_response(&err) {
            RuntimeResponse::Err { code, .. } => assert_eq!(code, Some(RuntimeErrorCode::Busy)),
            other => panic!("unexpected response: {other:?}"),
        }
    }
}
