//! End-to-end tests against a real monica-ptyd process: spawn the binary with a temp
//! MONICA_HOME, drive it through PtydClient, and assert sessions survive client
//! reconnects. PTY-backed, so like run::tests these can be environment-sensitive.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use monica_terminal_client::{ClientEvent, PtydClient};
use monica_terminal_protocol::{CreateParams, RequestOp, ResponseBody, PROTOCOL_VERSION};

struct DaemonGuard {
    child: Child,
    home: PathBuf,
}

impl DaemonGuard {
    fn socket(&self) -> PathBuf {
        self.home.join("ptyd.sock")
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn start_daemon(name: &str) -> DaemonGuard {
    // Plain /tmp with a short name: socket paths must stay under the (macOS 104-byte)
    // sun_path limit, which temp_dir()'s /var/folders/... prefix easily blows past.
    let home = PathBuf::from("/tmp").join(format!("mptyd-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();

    let child = Command::new(env!("CARGO_BIN_EXE_monica-ptyd"))
        .arg("--monica-home")
        .arg(&home)
        .arg("--foreground")
        .spawn()
        .expect("daemon binary should start");

    let guard = DaemonGuard { child, home };
    wait_until(Duration::from_secs(10), || guard.socket().exists());
    guard
}

fn wait_until(deadline: Duration, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + deadline;
    while !condition() {
        assert!(Instant::now() < end, "timed out waiting for condition");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn connect(guard: &DaemonGuard) -> (PtydClient, mpsc::Receiver<ClientEvent>) {
    let (tx, rx) = mpsc::channel();
    let client = PtydClient::connect(&guard.socket(), move |event| {
        let _ = tx.send(event);
    })
    .expect("client should connect");
    (client, rx)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn from_b64(data: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap()
}

fn create_zsh_session(client: &PtydClient, session_id: &str) -> Option<u32> {
    let body = client
        .request(RequestOp::Create(CreateParams {
            session_id: session_id.to_string(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            shell: Some("/bin/zsh".to_string()),
            rows: 24,
            cols: 80,
            env: None,
        }))
        .expect("create should succeed");
    match body {
        ResponseBody::Created { pid } => pid,
        other => panic!("unexpected create response: {other:?}"),
    }
}

fn wait_for_output(rx: &mpsc::Receiver<ClientEvent>, marker: &str, deadline: Duration) {
    let end = Instant::now() + deadline;
    let mut combined = String::new();
    while Instant::now() < end {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(ClientEvent::Output { data, .. }) => {
                combined.push_str(&String::from_utf8_lossy(&from_b64(&data)));
                if combined.contains(marker) {
                    return;
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("event channel closed: {e}"),
        }
    }
    panic!("marker {marker:?} not seen in output; got: {combined:?}");
}

#[test]
fn session_survives_client_reconnect_and_replays_output() {
    let daemon = start_daemon("reconnect");

    let (client, rx) = connect(&daemon);
    assert_eq!(client.hello().unwrap(), PROTOCOL_VERSION);

    let pid = create_zsh_session(&client, "ts-1");
    assert!(pid.is_some(), "unix spawns should expose a pid");

    match client
        .request(RequestOp::Attach {
            session_id: "ts-1".into(),
            replay_bytes: None,
        })
        .unwrap()
    {
        ResponseBody::Attached { rows, cols, .. } => assert_eq!((rows, cols), (24, 80)),
        other => panic!("unexpected attach response: {other:?}"),
    }

    client
        .notify(RequestOp::Write {
            session_id: "ts-1".into(),
            data: b64(b"echo marker-before-detach\r"),
        })
        .unwrap();
    wait_for_output(&rx, "marker-before-detach", Duration::from_secs(10));

    // The app going away entirely: EOF on the connection = implicit detach. The shell
    // must keep running under the daemon.
    drop(client);
    drop(rx);
    std::thread::sleep(Duration::from_millis(100));

    let (client2, rx2) = connect(&daemon);
    let replay = match client2
        .request(RequestOp::Attach {
            session_id: "ts-1".into(),
            replay_bytes: None,
        })
        .unwrap()
    {
        ResponseBody::Attached { replay, .. } => {
            String::from_utf8_lossy(&from_b64(&replay)).to_string()
        }
        other => panic!("unexpected attach response: {other:?}"),
    };
    assert!(
        replay.contains("marker-before-detach"),
        "replay should include pre-detach output, got: {replay:?}"
    );

    client2
        .notify(RequestOp::Write {
            session_id: "ts-1".into(),
            data: b64(b"echo marker-after-reattach\r"),
        })
        .unwrap();
    wait_for_output(&rx2, "marker-after-reattach", Duration::from_secs(10));

    // Explicit terminate is the only operation that kills the process.
    client2
        .request(RequestOp::Terminate {
            session_id: "ts-1".into(),
        })
        .unwrap();

    let end = Instant::now() + Duration::from_secs(10);
    let mut exited = false;
    while Instant::now() < end {
        match rx2.recv_timeout(Duration::from_millis(200)) {
            Ok(ClientEvent::Exit { session_id, .. }) => {
                assert_eq!(session_id, "ts-1");
                exited = true;
                break;
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("event channel closed: {e}"),
        }
    }
    assert!(exited, "terminate should produce an exit event");

    match client2.request(RequestOp::List).unwrap() {
        ResponseBody::Sessions { sessions } => {
            assert_eq!(sessions.len(), 1);
            assert!(!sessions[0].running, "terminated session should be a tombstone");
        }
        other => panic!("unexpected list response: {other:?}"),
    }

    client2
        .request(RequestOp::Reap {
            session_id: "ts-1".into(),
        })
        .unwrap();
    match client2.request(RequestOp::List).unwrap() {
        ResponseBody::Sessions { sessions } => assert!(sessions.is_empty()),
        other => panic!("unexpected list response: {other:?}"),
    }
}

#[test]
fn daemon_error_response_resolves_the_request() {
    let daemon = start_daemon("errors");
    let (client, _rx) = connect(&daemon);

    let err = client
        .request(RequestOp::Attach {
            session_id: "ts-nope".into(),
            replay_bytes: None,
        })
        .expect_err("attaching a nonexistent session must fail");
    assert!(
        err.to_string().contains("no such session"),
        "daemon error should round-trip to the client, got: {err:#}"
    );
}

#[test]
fn second_daemon_instance_exits_immediately() {
    let daemon = start_daemon("single-instance");

    let status = Command::new(env!("CARGO_BIN_EXE_monica-ptyd"))
        .arg("--monica-home")
        .arg(&daemon.home)
        .arg("--foreground")
        .status()
        .expect("second daemon should run");
    assert!(status.success(), "pid-locked duplicate must exit 0");

    // The original daemon must still be serving.
    let (client, _rx) = connect(&daemon);
    assert_eq!(client.hello().unwrap(), PROTOCOL_VERSION);
}
