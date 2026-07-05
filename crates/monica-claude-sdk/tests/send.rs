use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use monica_claude_sdk::{bracketed_paste_bytes, ensure_session_running, send_text};
use monica_terminal_client::PtydClient;
use monica_terminal_protocol::{
    Request, RequestOp, ResponseBody, ServerMessage, SessionInfo, PROTOCOL_VERSION,
};

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

struct MockDaemon {
    socket: PathBuf,
    writes: mpsc::Receiver<(String, Vec<u8>)>,
}

impl Drop for MockDaemon {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn session_info(session_id: &str, running: bool) -> SessionInfo {
    SessionInfo {
        session_id: session_id.to_string(),
        running,
        attached: false,
        pid: running.then_some(4242),
        exit_code: (!running).then_some(0),
        cwd: "/tmp".to_string(),
        rows: 24,
        cols: 80,
    }
}

/// Speaks just enough of the ptyd NDJSON protocol for the client under test:
/// answers Hello/List requests, decodes Write notifications into a channel.
fn start_mock(name: &str, sessions: Vec<SessionInfo>) -> MockDaemon {
    // Plain /tmp with a short name: socket paths must stay under the (macOS 104-byte)
    // sun_path limit, which temp_dir()'s /var/folders/... prefix easily blows past.
    let socket = PathBuf::from("/tmp").join(format!("mcsdk-{}-{name}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("mock daemon should bind");
    let (writes_tx, writes_rx) = mpsc::channel();

    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("client should connect");
        let mut writer = stream.try_clone().expect("stream should clone");
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let request: Request = serde_json::from_str(&line).expect("valid request line");
            let reply = match (request.id, request.op) {
                (Some(id), RequestOp::Hello { .. }) => Some(ServerMessage::Ok {
                    id,
                    body: ResponseBody::Hello {
                        version: PROTOCOL_VERSION,
                    },
                }),
                (Some(id), RequestOp::List) => Some(ServerMessage::Ok {
                    id,
                    body: ResponseBody::Sessions {
                        sessions: sessions.clone(),
                    },
                }),
                (None, RequestOp::Write { session_id, data }) => {
                    let bytes = BASE64.decode(&data).expect("valid base64 payload");
                    let _ = writes_tx.send((session_id, bytes));
                    None
                }
                (id, op) => panic!("unexpected request: id={id:?} op={op:?}"),
            };
            if let Some(message) = reply {
                let line = serde_json::to_string(&message).unwrap();
                writer.write_all(line.as_bytes()).unwrap();
                writer.write_all(b"\n").unwrap();
                writer.flush().unwrap();
            }
        }
    });

    MockDaemon {
        socket,
        writes: writes_rx,
    }
}

fn connect(mock: &MockDaemon) -> PtydClient {
    PtydClient::connect(&mock.socket, |_| {}).expect("client should connect")
}

#[test]
fn ensure_session_running_accepts_live_session() {
    let mock = start_mock("live", vec![session_info("ts-9", true)]);
    let client = connect(&mock);
    ensure_session_running(&client, "ts-9").expect("running session should pass");
}

#[test]
fn ensure_session_running_rejects_unknown_session() {
    let mock = start_mock("unknown", vec![session_info("ts-9", true)]);
    let client = connect(&mock);
    let err = ensure_session_running(&client, "ts-404").unwrap_err();
    assert!(err.to_string().contains("not known"), "got: {err}");
}

#[test]
fn ensure_session_running_rejects_exited_session() {
    let mock = start_mock("exited", vec![session_info("ts-9", false)]);
    let client = connect(&mock);
    let err = ensure_session_running(&client, "ts-9").unwrap_err();
    assert!(err.to_string().contains("exited"), "got: {err}");
}

#[test]
fn send_text_writes_paste_then_enter() {
    let mock = start_mock("send", vec![]);
    let client = connect(&mock);
    send_text(&client, "ts-9", "こんにちは\nworld").expect("send should succeed");

    let (session_id, paste) = mock.writes.recv_timeout(RECV_TIMEOUT).unwrap();
    assert_eq!(session_id, "ts-9");
    assert_eq!(paste, bracketed_paste_bytes("こんにちは\nworld"));

    let (session_id, submit) = mock.writes.recv_timeout(RECV_TIMEOUT).unwrap();
    assert_eq!(session_id, "ts-9");
    assert_eq!(submit, b"\r");
}
