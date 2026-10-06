//! End-to-end tests against a real tania-ptyd process: spawn the binary with a temp
//! TANIA_HOME, drive it through PtydClient, and assert sessions survive client
//! reconnects. PTY-backed, so like run::tests these can be environment-sensitive.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use tania_terminal_client::{ClientEvent, PtydClient};
use tania_terminal_protocol::{CreateParams, RequestOp, ResponseBody, PROTOCOL_VERSION};

struct DaemonGuard {
    child: Child,
    /// Removed on drop; the daemon's home is this dir or somewhere inside it.
    dir: PathBuf,
    socket: PathBuf,
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fresh_dir(name: &str) -> PathBuf {
    // Plain /tmp keeps socket paths well under the (macOS 104-byte) sun_path limit;
    // temp_dir()'s /var/folders/... prefix alone spends about half of it.
    let dir = PathBuf::from("/tmp").join(format!("ptyd-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn daemon_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tania-ptyd"));
    command.arg("--foreground");
    command
}

fn spawn_daemon(mut command: Command, dir: PathBuf, socket: PathBuf) -> DaemonGuard {
    let child = command.spawn().expect("daemon binary should start");
    let guard = DaemonGuard { child, dir, socket };
    wait_until(Duration::from_secs(10), || guard.socket.exists());
    guard
}

fn start_daemon(name: &str) -> DaemonGuard {
    let home = fresh_dir(name);
    let mut command = daemon_command();
    command.arg("--tania-home").arg(&home);
    let socket = home.join("ptyd.sock");
    spawn_daemon(command, home, socket)
}

fn wait_until(deadline: Duration, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + deadline;
    while !condition() {
        assert!(Instant::now() < end, "timed out waiting for condition");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_daemon_exit(daemon: &mut DaemonGuard) {
    let mut status = None;
    wait_until(Duration::from_secs(5), || {
        status = daemon.child.try_wait().unwrap();
        status.is_some()
    });
    assert!(status.unwrap().success(), "daemon should exit cleanly");
}

fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists; nothing is delivered.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn connect(guard: &DaemonGuard) -> (PtydClient, mpsc::Receiver<ClientEvent>) {
    let (tx, rx) = mpsc::channel();
    let client = PtydClient::connect(&guard.socket, move |event| {
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
    // must keep running under the daemon, past at least one of its 2s socket checks.
    drop(client);
    drop(rx);
    std::thread::sleep(Duration::from_millis(2500));

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
            assert!(
                !sessions[0].running,
                "terminated session should be a tombstone"
            );
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
fn removing_the_home_ends_the_daemon_and_its_shells() {
    let mut daemon = start_daemon("home-removed");
    let (client, rx) = connect(&daemon);
    let shell = create_zsh_session(&client, "ts-1").expect("unix spawns should expose a pid");
    drop(client);
    drop(rx);

    std::fs::remove_dir_all(&daemon.dir).unwrap();

    wait_for_daemon_exit(&mut daemon);
    wait_until(Duration::from_secs(5), || !process_alive(shell));
}

#[test]
fn replacing_the_socket_ends_the_daemon() {
    let mut daemon = start_daemon("socket-replaced");

    // rename() swaps the file in one step, so the path never goes missing and only its
    // identity tells the daemon the socket is no longer its own.
    let stand_in = daemon.dir.join("stand-in");
    std::fs::write(&stand_in, b"").unwrap();
    std::fs::rename(&stand_in, &daemon.socket).unwrap();

    wait_for_daemon_exit(&mut daemon);
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

    let status = daemon_command()
        .arg("--tania-home")
        .arg(&daemon.dir)
        .status()
        .expect("second daemon should run");
    assert!(status.success(), "pid-locked duplicate must exit 0");

    // The original daemon must still be serving.
    let (client, _rx) = connect(&daemon);
    assert_eq!(client.hello().unwrap(), PROTOCOL_VERSION);
}

#[test]
fn without_tania_home_the_daemon_lives_in_dot_tania_under_home() {
    let user_home = fresh_dir("default-home");
    let mut command = daemon_command();
    command.env("HOME", &user_home).env_remove("TANIA_HOME");
    let socket = user_home.join(".tania").join("ptyd.sock");
    let daemon = spawn_daemon(command, user_home, socket);

    let (client, _rx) = connect(&daemon);
    assert_eq!(client.hello().unwrap(), PROTOCOL_VERSION);
}
