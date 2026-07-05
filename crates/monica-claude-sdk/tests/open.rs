use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use monica_claude_sdk::{open_session_at, OpenSessionParams};
use monica_sdk_protocol::{SdkRequest, SdkResponse, SdkSessionInfo};

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

struct MockServer {
    socket: PathBuf,
    requests: mpsc::Receiver<SdkRequest>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn session_info() -> SdkSessionInfo {
    SdkSessionInfo {
        runspace_id: "sdk".to_string(),
        tab_id: "tab-1".to_string(),
        session_id: "ts-42".to_string(),
        claude_session_id: "5e0f5b0e-9f5c-4a4e-9d6e-000000000000".to_string(),
        cwd: "/tmp".to_string(),
        initial_command: "claude --session-id 5e0f5b0e-9f5c-4a4e-9d6e-000000000000".to_string(),
        title: None,
    }
}

/// Answers exactly one request with the canned response (`None` = close the connection
/// without answering), recording the request for main-thread assertions.
fn start_mock(name: &str, response: Option<SdkResponse>) -> MockServer {
    // Plain /tmp with a short name: socket paths must stay under the (macOS 104-byte)
    // sun_path limit, which temp_dir()'s /var/folders/... prefix easily blows past.
    let socket = PathBuf::from("/tmp").join(format!("mcsdk-o-{}-{name}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("mock server should bind");
    let (requests_tx, requests_rx) = mpsc::channel();

    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("client should connect");
        let mut reader = BufReader::new(stream.try_clone().expect("stream should clone"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("request line");
        let request: SdkRequest = serde_json::from_str(&line).expect("valid request line");
        let _ = requests_tx.send(request);
        let Some(response) = response else { return };
        let mut payload = serde_json::to_string(&response).unwrap();
        payload.push('\n');
        let mut stream = stream;
        stream.write_all(payload.as_bytes()).unwrap();
    });

    MockServer { socket, requests: requests_rx }
}

fn params() -> OpenSessionParams {
    OpenSessionParams {
        cwd: "/tmp".to_string(),
        model: Some("opus".to_string()),
        title: Some("hello".to_string()),
    }
}

#[test]
fn sends_a_versioned_request_and_returns_the_session() {
    let mock = start_mock("ok", Some(SdkResponse::Ok { session: session_info() }));
    let session = open_session_at(&mock.socket, params()).expect("open should succeed");
    assert_eq!(session.session_id, "ts-42");
    assert_eq!(session.runspace_id, "sdk");
    assert_eq!(
        session.claude_session_id,
        "5e0f5b0e-9f5c-4a4e-9d6e-000000000000"
    );

    let request = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    assert_eq!(request.version, monica_sdk_protocol::PROTOCOL_VERSION);
    let monica_sdk_protocol::SdkRequestOp::OpenSdkSession { cwd, model, title } = request.op;
    assert_eq!(cwd, "/tmp");
    assert_eq!(model.as_deref(), Some("opus"));
    assert_eq!(title.as_deref(), Some("hello"));
}

#[test]
fn err_response_surfaces_the_server_message() {
    let mock = start_mock(
        "err",
        Some(SdkResponse::Err { error: "cwd is not an existing directory: /nope".to_string() }),
    );
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("cwd is not an existing directory"), "got: {err}");
}

#[test]
fn server_closing_without_a_response_is_an_error() {
    let mock = start_mock("drop", None);
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("without a response"), "got: {err}");
}

#[test]
fn relative_cwd_is_absolutized_before_sending() {
    let mock = start_mock("relcwd", Some(SdkResponse::Ok { session: session_info() }));
    let mut relative = params();
    relative.cwd = "rel-dir".to_string();
    open_session_at(&mock.socket, relative).expect("open should succeed");

    let request = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    let monica_sdk_protocol::SdkRequestOp::OpenSdkSession { cwd, .. } = request.op;
    let expected = std::path::absolute("rel-dir").unwrap();
    assert_eq!(cwd, expected.to_string_lossy());
}

#[test]
fn missing_socket_points_at_the_app() {
    let socket = PathBuf::from("/tmp").join(format!("mcsdk-o-{}-gone.sock", std::process::id()));
    let err = open_session_at(&socket, params()).unwrap_err();
    assert!(err.to_string().contains("is the Monica app running"), "got: {err}");
}
