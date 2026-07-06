use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use monica_agent_runtime_protocol::{
    ClaudeSessionInfo, ClaudeSessionSummary, RuntimeErrorCode, RuntimeRequest, RuntimeRequestOp,
    RuntimeResponse, SessionEvent,
};
use monica_claude_sdk::{ClaudeRuntime, CreateSessionParams, SessionBusy, SessionEnded};

fn ended_err() -> RuntimeResponse {
    RuntimeResponse::Err {
        error: "the claude session has ended".to_string(),
        indeterminate: false,
        code: Some(RuntimeErrorCode::SessionEnded),
    }
}

const RECV_TIMEOUT: Duration = Duration::from_secs(5);
const CANNED_ID: &str = "5e0f5b0e-9f5c-4a4e-9d6e-000000000000";

struct ScriptedServer {
    socket: PathBuf,
    requests: mpsc::Receiver<RuntimeRequest>,
}

impl Drop for ScriptedServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Serves the scripts in connection order: each connection reads one request line,
/// records it, writes its script's response lines, and closes. A closed connection after
/// the script is the protocol's normal end-of-stream for `subscribe`.
fn start_scripted(name: &str, scripts: Vec<Vec<RuntimeResponse>>) -> ScriptedServer {
    // Plain /tmp with a short name: socket paths must stay under the (macOS 104-byte)
    // sun_path limit, which temp_dir()'s /var/folders/... prefix easily blows past.
    let socket = PathBuf::from("/tmp").join(format!("mcsdk-r-{}-{name}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("mock server should bind");
    let (requests_tx, requests_rx) = mpsc::channel();

    std::thread::spawn(move || {
        for script in scripts {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().expect("stream should clone"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("request line");
            let request: RuntimeRequest = serde_json::from_str(&line).expect("valid request line");
            let _ = requests_tx.send(request);
            let mut stream = stream;
            for response in script {
                let mut payload = serde_json::to_string(&response).unwrap();
                payload.push('\n');
                stream.write_all(payload.as_bytes()).unwrap();
            }
        }
    });

    ScriptedServer { socket, requests: requests_rx }
}

fn session_info() -> ClaudeSessionInfo {
    ClaudeSessionInfo {
        runspace_id: "agent-runtime".to_string(),
        tab_id: "tab-1".to_string(),
        session_id: "ts-42".to_string(),
        claude_session_id: CANNED_ID.to_string(),
        cwd: "/tmp".to_string(),
        initial_command: format!("claude --session-id {CANNED_ID}"),
        title: None,
        jsonl_path: format!("/home/user/.claude/projects/-tmp/{CANNED_ID}.jsonl"),
    }
}

fn summary() -> ClaudeSessionSummary {
    ClaudeSessionSummary {
        claude_session_id: CANNED_ID.to_string(),
        tab_id: "tab-1".to_string(),
        terminal_session_id: "ts-42".to_string(),
        cwd: "/tmp".to_string(),
        name: None,
        session_status: "active".to_string(),
        conversation_status: "idle".to_string(),
        wait_reason: None,
        created_at: "2026-07-06T00:00:00Z".to_string(),
        ended_at: None,
    }
}

fn params() -> CreateSessionParams {
    CreateSessionParams { cwd: "/tmp".to_string(), model: None, title: None }
}

fn event(event: SessionEvent) -> RuntimeResponse {
    RuntimeResponse::Event { claude_session_id: CANNED_ID.to_string(), event }
}

fn busy_err() -> RuntimeResponse {
    RuntimeResponse::Err {
        error: "busy".to_string(),
        indeterminate: false,
        code: Some(RuntimeErrorCode::Busy),
    }
}

#[test]
fn get_or_create_opens_then_subscribes_and_streams_until_ended() {
    let mock = start_scripted(
        "stream",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![
                RuntimeResponse::Ack,
                event(SessionEvent::Idle),
                event(SessionEvent::ToolUse {
                    tool_use_id: "t-1".into(),
                    name: "Bash".into(),
                    input_json: "{}".into(),
                }),
                event(SessionEvent::AssistantMessage { text: "answer".into() }),
                event(SessionEvent::Ended),
            ],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);

    let mut session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();
    assert_eq!(session.claude_session_id(), CANNED_ID);
    assert_eq!(session.terminal_session_id(), "ts-42");
    assert!(session.info().is_some());

    // The two connections carried the expected ops, in order.
    let open = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    assert!(matches!(open.op, RuntimeRequestOp::OpenClaudeSession { .. }));
    let subscribe = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    let RuntimeRequestOp::Subscribe { claude_session_id } = subscribe.op else {
        panic!("expected subscribe, got {:?}", subscribe.op);
    };
    assert_eq!(claude_session_id, CANNED_ID);

    assert_eq!(session.next_event().unwrap(), SessionEvent::Idle);
    assert!(matches!(session.next_event().unwrap(), SessionEvent::ToolUse { .. }));
    assert_eq!(
        session.next_event().unwrap(),
        SessionEvent::AssistantMessage { text: "answer".into() }
    );
    assert_eq!(session.next_event().unwrap(), SessionEvent::Ended);

    // Past Ended the stream is over, as a typed error.
    let err = session.next_event().unwrap_err();
    assert!(err.chain().any(|c| c.downcast_ref::<SessionEnded>().is_some()), "got: {err:#}");
}

#[test]
fn wait_until_idle_ignores_pings_and_acks() {
    let mock = start_scripted(
        "ping",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Ack, RuntimeResponse::Ping, event(SessionEvent::Idle)],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);
    let mut session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();

    session.wait_until_idle().unwrap();
}

#[test]
fn wait_until_idle_reports_a_session_that_ends_first() {
    let mock = start_scripted(
        "endfirst",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Ack, event(SessionEvent::Ended)],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);
    let mut session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();

    let err = session.wait_until_idle().unwrap_err();
    assert!(err.chain().any(|c| c.downcast_ref::<SessionEnded>().is_some()), "got: {err:#}");
}

#[test]
fn an_eof_before_ended_is_a_lost_stream_not_a_clean_end() {
    let mock = start_scripted(
        "lost",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Ack, event(SessionEvent::Idle)],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);
    let mut session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();

    assert_eq!(session.next_event().unwrap(), SessionEvent::Idle);
    let err = session.next_event().unwrap_err();
    assert!(err.chain().all(|c| c.downcast_ref::<SessionEnded>().is_none()));
    assert!(format!("{err:#}").contains("lost"), "got: {err:#}");
}

#[test]
fn send_user_message_acks_and_classifies_busy() {
    let mock = start_scripted(
        "send",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Ack],
            vec![RuntimeResponse::Ack],
            vec![busy_err()],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);
    let session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();
    // Drain the open + subscribe requests.
    mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();

    session.send_user_message("今日の日付を教えて").unwrap();
    let sent = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    let RuntimeRequestOp::SendUserMessage { claude_session_id, text } = sent.op else {
        panic!("expected send_user_message, got {:?}", sent.op);
    };
    assert_eq!(claude_session_id, CANNED_ID);
    assert_eq!(text, "今日の日付を教えて");

    let err = session.send_user_message("second").unwrap_err();
    assert!(err.chain().any(|c| c.downcast_ref::<SessionBusy>().is_some()), "got: {err:#}");
}

#[test]
fn interrupt_sends_its_op_and_acks() {
    let mock = start_scripted(
        "intr",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Ack],
            vec![RuntimeResponse::Ack],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);
    let session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();
    mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();

    session.interrupt().unwrap();

    let sent = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    assert!(matches!(sent.op, RuntimeRequestOp::InterruptSession { .. }));
}

#[test]
fn list_sessions_returns_summaries_and_session_attaches_through_them() {
    let mock = start_scripted(
        "list",
        vec![
            vec![RuntimeResponse::Sessions { sessions: vec![summary()] }],
            vec![RuntimeResponse::Sessions { sessions: vec![summary()] }],
            vec![RuntimeResponse::Ack, event(SessionEvent::Idle)],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);

    let sessions = runtime.list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].claude_session_id, CANNED_ID);
    assert_eq!(sessions[0].conversation_status, "idle");

    // Attach resolves the terminal session through the listing, then subscribes.
    let mut session = runtime.session(CANNED_ID).unwrap();
    assert_eq!(session.terminal_session_id(), "ts-42");
    assert!(session.info().is_none());
    assert_eq!(session.next_event().unwrap(), SessionEvent::Idle);
}

#[test]
fn a_rejected_subscribe_fails_the_attach() {
    let mock = start_scripted(
        "reject",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Err {
                error: "claude session not found".to_string(),
                indeterminate: false,
                code: Some(RuntimeErrorCode::NotFound),
            }],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);

    let err = runtime.get_or_create_session(CANNED_ID, params()).unwrap_err();
    assert!(format!("{err:#}").contains("subscribe rejected"), "got: {err:#}");
}

#[test]
fn send_user_message_classifies_an_ended_session() {
    let mock = start_scripted(
        "sendend",
        vec![
            vec![RuntimeResponse::Ok { session: session_info() }],
            vec![RuntimeResponse::Ack],
            vec![ended_err()],
        ],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);
    let session = runtime.get_or_create_session(CANNED_ID, params()).unwrap();

    let err = session.send_user_message("too late").unwrap_err();
    assert!(err.chain().any(|c| c.downcast_ref::<SessionEnded>().is_some()), "got: {err:#}");
}

#[test]
fn a_subscribe_rejected_as_ended_downcasts_to_session_ended() {
    let mock = start_scripted(
        "subend",
        vec![vec![RuntimeResponse::Ok { session: session_info() }], vec![ended_err()]],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);

    let err = runtime.get_or_create_session(CANNED_ID, params()).unwrap_err();
    assert!(err.chain().any(|c| c.downcast_ref::<SessionEnded>().is_some()), "got: {err:#}");
}

#[test]
fn attaching_to_an_unknown_session_fails() {
    let mock = start_scripted(
        "unknown",
        vec![vec![RuntimeResponse::Sessions { sessions: Vec::new() }]],
    );
    let runtime = ClaudeRuntime::connect_at(&mock.socket);

    let err = runtime.session(CANNED_ID).unwrap_err();
    assert!(format!("{err:#}").contains("not found"), "got: {err:#}");
}
