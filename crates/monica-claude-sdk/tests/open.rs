use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use monica_claude_sdk::{open_session_at, OpenSessionIndeterminate, OpenSessionParams};
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

const CANNED_ID: &str = "5e0f5b0e-9f5c-4a4e-9d6e-000000000000";

fn session_info() -> SdkSessionInfo {
    SdkSessionInfo {
        runspace_id: "sdk".to_string(),
        tab_id: "tab-1".to_string(),
        session_id: "ts-42".to_string(),
        claude_session_id: CANNED_ID.to_string(),
        cwd: "/tmp".to_string(),
        initial_command: format!("claude --session-id {CANNED_ID}"),
        title: None,
        jsonl_path: None,
    }
}

/// Reads one request off a freshly bound socket, hands it to `write` to produce the raw
/// reply bytes (empty = close without answering), and records the request for main-thread
/// assertions.
fn start_mock_write(
    name: &str,
    write: impl FnOnce(&SdkRequest) -> Vec<u8> + Send + 'static,
) -> MockServer {
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
        let payload = write(&request);
        let _ = requests_tx.send(request);
        if payload.is_empty() {
            return;
        }
        let mut stream = stream;
        stream.write_all(&payload).unwrap();
    });

    MockServer { socket, requests: requests_rx }
}

/// Answers exactly one request with a response built from it (`None` = close the
/// connection without answering).
fn start_mock_with(
    name: &str,
    respond: impl FnOnce(&SdkRequest) -> Option<SdkResponse> + Send + 'static,
) -> MockServer {
    start_mock_write(name, move |request| {
        let Some(response) = respond(request) else { return Vec::new() };
        let mut payload = serde_json::to_string(&response).unwrap();
        payload.push('\n');
        payload.into_bytes()
    })
}

fn start_mock(name: &str, response: Option<SdkResponse>) -> MockServer {
    start_mock_with(name, move |_| response)
}

/// Reads one request, then writes `raw` verbatim (no framing added) and closes — a server
/// that died mid-response or answered something that is not the NDJSON protocol.
fn start_mock_raw(name: &str, raw: &'static [u8]) -> MockServer {
    start_mock_write(name, move |_| raw.to_vec())
}

/// A well-behaved current server: answers with the request's own claude_session_id.
fn start_echo_mock(name: &str) -> MockServer {
    start_mock_with(name, |request| {
        let monica_sdk_protocol::SdkRequestOp::OpenSdkSession { claude_session_id, .. } =
            &request.op;
        let mut session = session_info();
        session.claude_session_id =
            claude_session_id.clone().expect("client should always send an id");
        Some(SdkResponse::Ok { session })
    })
}

fn params() -> OpenSessionParams {
    OpenSessionParams {
        cwd: "/tmp".to_string(),
        model: Some("opus".to_string()),
        title: Some("hello".to_string()),
        claude_session_id: Some(CANNED_ID.to_string()),
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
    let monica_sdk_protocol::SdkRequestOp::OpenSdkSession { cwd, model, title, claude_session_id } =
        request.op;
    assert_eq!(cwd, "/tmp");
    assert_eq!(model.as_deref(), Some("opus"));
    assert_eq!(title.as_deref(), Some("hello"));
    assert_eq!(claude_session_id.as_deref(), Some(CANNED_ID));
}

#[test]
fn mints_a_claude_session_id_when_none_is_supplied() {
    let mock = start_echo_mock("mint");
    let mut no_id = params();
    no_id.claude_session_id = None;

    let session = open_session_at(&mock.socket, no_id).expect("open should succeed");

    let request = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    let monica_sdk_protocol::SdkRequestOp::OpenSdkSession { claude_session_id, .. } = request.op;
    let sent = claude_session_id.expect("the request should carry a minted id");
    uuid::Uuid::parse_str(&sent).expect("the minted id should be a uuid");
    assert_eq!(session.claude_session_id, sent);
}

#[test]
fn echoed_id_mismatch_fails_instead_of_breaking_idempotency() {
    // A server that speaks the current version but ignores the request's
    // claude_session_id answers with its own mint (here the canned id), which must
    // surface as an error, not as a silent non-idempotent success.
    let mock = start_mock("stale", Some(SdkResponse::Ok { session: session_info() }));
    let mut other_id = params();
    other_id.claude_session_id = Some("00000000-0000-4000-8000-000000000309".to_string());

    let err = open_session_at(&mock.socket, other_id).unwrap_err();

    assert!(err.to_string().contains("ignored the client-supplied"), "got: {err}");
    assert!(err.to_string().contains(CANNED_ID), "the running session's id is named: {err}");
}

#[test]
fn err_response_surfaces_the_server_message() {
    let mock = start_mock(
        "err",
        Some(SdkResponse::Err {
            error: "cwd is not an existing directory: /nope".to_string(),
            indeterminate: false,
        }),
    );
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("cwd is not an existing directory"), "got: {err}");
    assert!(
        err.downcast_ref::<OpenSessionIndeterminate>().is_none(),
        "a determinate rejection proves no session was left behind"
    );
}

#[test]
fn indeterminate_err_response_downcasts_with_the_sent_id() {
    // The server itself could not resolve the outcome (e.g. the id maps to a launch
    // reservation another open holds): same contract as a lost response — the typed
    // retry key must survive so the caller retries with this id, never a fresh one.
    let mock = start_mock(
        "pend",
        Some(SdkResponse::Err {
            error: "claude session has an unconfirmed launch".to_string(),
            indeterminate: true,
        }),
    );
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("did not resolve"), "got: {err}");
    let indeterminate = err
        .downcast_ref::<OpenSessionIndeterminate>()
        .expect("a server-side indeterminate outcome must downcast");
    assert_eq!(indeterminate.claude_session_id, CANNED_ID);
}

#[test]
fn server_closing_without_a_response_is_an_error_carrying_the_retry_key() {
    let mock = start_mock("drop", None);
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("without a response"), "got: {err}");
    // The indeterminate outcome must expose the id in a structured form, so retry code
    // can carry it without parsing error prose.
    let indeterminate = err
        .downcast_ref::<OpenSessionIndeterminate>()
        .expect("an unknown outcome must downcast to OpenSessionIndeterminate");
    assert_eq!(indeterminate.claude_session_id, CANNED_ID);
}

#[test]
fn lost_response_recovers_the_minted_id_through_the_typed_error() {
    let mock = start_mock("dropmint", None);
    let mut no_id = params();
    no_id.claude_session_id = None;

    let err = open_session_at(&mock.socket, no_id).unwrap_err();

    let recovered = err
        .downcast_ref::<OpenSessionIndeterminate>()
        .expect("an unknown outcome must downcast to OpenSessionIndeterminate")
        .claude_session_id
        .clone();
    let request = mock.requests.recv_timeout(RECV_TIMEOUT).unwrap();
    let monica_sdk_protocol::SdkRequestOp::OpenSdkSession { claude_session_id, .. } = request.op;
    assert_eq!(Some(recovered), claude_session_id, "the error must carry the id that was sent");
}

#[test]
fn truncated_response_is_indeterminate_and_carries_the_retry_key() {
    // The server got the request (so it may have launched) but died mid-write: read_line
    // returns the partial line on EOF, so the failure surfaces at JSON parsing, not I/O —
    // and it must stay recoverable exactly like a dropped connection.
    let mock = start_mock_raw("trunc", br#"{"type":"ok","session":{"runspace_id":"sdk""#);
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("unparseable response"), "got: {err}");
    let indeterminate = err
        .downcast_ref::<OpenSessionIndeterminate>()
        .expect("a parse failure after the request was sent must downcast");
    assert_eq!(indeterminate.claude_session_id, CANNED_ID);
}

#[test]
fn non_ndjson_response_is_indeterminate_and_carries_the_retry_key() {
    let mock = start_mock_raw("garbage", b"HTTP/1.1 400 Bad Request\r\n");
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    let indeterminate = err
        .downcast_ref::<OpenSessionIndeterminate>()
        .expect("a non-protocol response after the request was sent must downcast");
    assert_eq!(indeterminate.claude_session_id, CANNED_ID);
}

#[test]
fn v1_server_version_rejection_is_determinate() {
    // A v1 server rejects the version mismatch before launching anything, so this
    // failure proves no session was left behind: no OpenSessionIndeterminate, retry
    // (or fall back) freely.
    let mock = start_mock(
        "v1",
        Some(SdkResponse::Err {
            error: "sdk protocol version mismatch: client=2, server=1".to_string(),
            indeterminate: false,
        }),
    );
    let err = open_session_at(&mock.socket, params()).unwrap_err();
    assert!(err.to_string().contains("version mismatch"), "got: {err}");
    assert!(
        err.downcast_ref::<OpenSessionIndeterminate>().is_none(),
        "a server-reported rejection is not an unknown outcome"
    );
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
