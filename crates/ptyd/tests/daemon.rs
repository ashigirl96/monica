//! End-to-end tests against a real monica-ptyd process: spawn the binary with a temp
//! MONICA_HOME, drive it through PtydClient, and assert sessions survive client
//! reconnects. PTY-backed, so like run::tests these can be environment-sensitive.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use monica_terminal_client::{ClientEvent, PtydClient};
use monica_terminal_protocol::{
    CreateParams, ProcessInfo, RequestOp, ResponseBody, PROTOCOL_VERSION,
};

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
    let mut command = Command::new(env!("CARGO_BIN_EXE_monica-ptyd"));
    command.arg("--foreground");
    command
}

fn spawn_daemon(mut command: Command, dir: PathBuf, socket: PathBuf) -> DaemonGuard {
    let child = command.spawn().expect("daemon binary should start");
    let guard = DaemonGuard { child, dir, socket };
    // bind(2) creates the socket file before listen(2), and a connect between them is refused.
    wait_until(Duration::from_secs(10), || {
        std::os::unix::net::UnixStream::connect(&guard.socket).is_ok()
    });
    guard
}

fn start_daemon(name: &str) -> DaemonGuard {
    let home = fresh_dir(name);
    let mut command = daemon_command();
    command.arg("--monica-home").arg(&home);
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

fn wait_for_output_where<T>(
    rx: &mpsc::Receiver<ClientEvent>,
    what: &str,
    deadline: Duration,
    mut found: impl FnMut(&str) -> Option<T>,
) -> T {
    let end = Instant::now() + deadline;
    let mut combined = String::new();
    while Instant::now() < end {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(ClientEvent::Output { data, .. }) => {
                combined.push_str(&String::from_utf8_lossy(&from_b64(&data)));
                if let Some(value) = found(&combined) {
                    return value;
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("event channel closed: {e}"),
        }
    }
    panic!("{what} not seen in output; got: {combined:?}");
}

fn wait_for_output(rx: &mpsc::Receiver<ClientEvent>, marker: &str, deadline: Duration) {
    wait_for_output_where(rx, &format!("marker {marker:?}"), deadline, |output| {
        output.contains(marker).then_some(())
    });
}

fn wait_for_number_after(rx: &mpsc::Receiver<ClientEvent>, prefix: &str) -> u32 {
    let what = format!("{prefix:?} and a number");
    wait_for_output_where(rx, &what, Duration::from_secs(10), |output| {
        // The echoed command line carries the prefix too, followed by `$$` rather than digits.
        output.match_indices(prefix).find_map(|(at, _)| {
            let digits: String = output[at + prefix.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
    })
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
fn terminate_ends_the_foreground_job_with_its_shell() {
    let daemon = start_daemon("terminate-job");
    let (client, rx) = connect(&daemon);
    create_zsh_session(&client, "ts-1").expect("unix spawns should expose a pid");
    client
        .request(RequestOp::Attach {
            session_id: "ts-1".into(),
            replay_bytes: None,
        })
        .unwrap();

    // The job runs in the foreground as claude would, in its own process group under the shell.
    client
        .notify(RequestOp::Write {
            session_id: "ts-1".into(),
            data: b64(b"sh -c 'echo job-pid-$$; exec sleep 600'\r"),
        })
        .unwrap();
    let job = wait_for_number_after(&rx, "job-pid-");
    assert!(
        process_alive(job),
        "the job should be running before the terminate"
    );

    client
        .request(RequestOp::Terminate {
            session_id: "ts-1".into(),
        })
        .unwrap();

    wait_until(Duration::from_secs(5), || !process_alive(job));
}

/// SIGKILLs every pid on drop, so a failing test leaves no `sleep 600` behind.
struct Strays(Vec<u32>);

impl Drop for Strays {
    fn drop(&mut self) {
        for &pid in &self.0 {
            // SAFETY: kill(2) takes plain values.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
    }
}

fn create_attached_zsh(client: &PtydClient, session_id: &str) -> u32 {
    let shell = create_zsh_session(client, session_id).expect("unix spawns should expose a pid");
    client
        .request(RequestOp::Attach {
            session_id: session_id.into(),
            replay_bytes: None,
        })
        .unwrap();
    shell
}

fn type_and_read_pid(
    client: &PtydClient,
    rx: &mpsc::Receiver<ClientEvent>,
    session_id: &str,
    line: &str,
    prefix: &str,
) -> u32 {
    client
        .notify(RequestOp::Write {
            session_id: session_id.into(),
            data: b64(format!("{line}\r").as_bytes()),
        })
        .unwrap();
    wait_for_number_after(rx, prefix)
}

/// A `&` job, a nohup child, a nohup child that ignores SIGTERM, then a foreground job.
fn start_session_children(
    client: &PtydClient,
    rx: &mpsc::Receiver<ClientEvent>,
    session_id: &str,
) -> [u32; 4] {
    let background = type_and_read_pid(
        client,
        rx,
        session_id,
        "sleep 600 & echo bg-pid-$!",
        "bg-pid-",
    );
    let nohup = type_and_read_pid(
        client,
        rx,
        session_id,
        "nohup sleep 600 >/dev/null 2>&1 & echo nohup-pid-$!",
        "nohup-pid-",
    );
    let stubborn = type_and_read_pid(
        client,
        rx,
        session_id,
        "nohup sh -c 'trap \"\" TERM; exec sleep 600' >/dev/null 2>&1 & echo stubborn-pid-$!",
        "stubborn-pid-",
    );
    let foreground = type_and_read_pid(
        client,
        rx,
        session_id,
        "sh -c 'echo fg-pid-$$; exec sleep 600'",
        "fg-pid-",
    );
    [foreground, background, nohup, stubborn]
}

/// The 7 seconds the spec allows after the shell ends, and a little for the `ps` runs and the poll.
const LEFT_BEHIND_ENDED_WITHIN: Duration = Duration::from_millis(7500);

fn wait_until_ended(exited: Instant, pids: &[u32]) {
    wait_until(
        LEFT_BEHIND_ENDED_WITHIN.saturating_sub(exited.elapsed()),
        || pids.iter().all(|&pid| !process_alive(pid)),
    );
}

fn wait_for_exit(rx: &mpsc::Receiver<ClientEvent>, session_id: &str) {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(ClientEvent::Exit { session_id: id, .. }) if id == session_id => return,
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("event channel closed: {e}"),
        }
    }
    panic!("{session_id} never exited");
}

#[test]
fn terminate_ends_what_is_left_in_the_shells_session_and_spares_the_rest() {
    let daemon = start_daemon("terminate-session");
    let (client, rx) = connect(&daemon);
    let mut strays = Strays(Vec::new());

    create_attached_zsh(&client, "ts-2");
    let other_session = type_and_read_pid(
        &client,
        &rx,
        "ts-2",
        "nohup sleep 600 >/dev/null 2>&1 & echo other-pid-$!",
        "other-pid-",
    );
    strays.0.push(other_session);
    let mut outside = Command::new("sleep").arg("600").spawn().unwrap();
    strays.0.push(outside.id());

    create_attached_zsh(&client, "ts-1");
    let escaped = type_and_read_pid(
        &client,
        &rx,
        "ts-1",
        "perl -MPOSIX -e 'exit if fork; POSIX::setsid(); print \"setsid-pid-$$\\n\"; \
         open STDIN, \"</dev/null\"; open STDOUT, \">/dev/null\"; open STDERR, \">/dev/null\"; \
         exec \"sleep\", \"600\"'",
        "setsid-pid-",
    );
    strays.0.push(escaped);
    let children = start_session_children(&client, &rx, "ts-1");
    strays.0.extend(children);

    client
        .request(RequestOp::Terminate {
            session_id: "ts-1".into(),
        })
        .unwrap();
    wait_for_exit(&rx, "ts-1");
    let exited = Instant::now();

    // A claude got SIGHUP with its shell and still needs time to send SessionEnd.
    std::thread::sleep(Duration::from_millis(1800));
    let [_, _, nohup, _] = children;
    assert!(
        process_alive(nohup),
        "SIGTERM must wait 2 seconds after the shell ends"
    );

    wait_until_ended(exited, &children);
    for (pid, what) in [
        (escaped, "the setsid child"),
        (other_session, "the other Terminal Session's child"),
        (outside.id(), "the process outside any Terminal Session"),
    ] {
        assert!(process_alive(pid), "{what} should survive");
    }
    let _ = outside.kill();
    let _ = outside.wait();
}

#[test]
fn a_shell_that_exits_on_its_own_takes_what_is_left_in_its_session() {
    let daemon = start_daemon("exit-session");
    let (client, rx) = connect(&daemon);
    create_attached_zsh(&client, "ts-1");
    let children = start_session_children(&client, &rx, "ts-1");
    let _strays = Strays(children.to_vec());

    // Suspend the foreground job, then exit twice: zsh refuses the first exit while jobs remain.
    client
        .notify(RequestOp::Write {
            session_id: "ts-1".into(),
            data: b64(b"\x1a"),
        })
        .unwrap();
    for _ in 0..2 {
        client
            .notify(RequestOp::Write {
                session_id: "ts-1".into(),
                data: b64(b"exit\r"),
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
    }
    wait_for_exit(&rx, "ts-1");
    let exited = Instant::now();

    wait_until_ended(exited, &children);
}

fn processes(client: &PtydClient, session_id: &str) -> Vec<ProcessInfo> {
    match client
        .request(RequestOp::Processes {
            session_id: session_id.into(),
        })
        .unwrap()
    {
        ResponseBody::Processes { processes } => processes,
        other => panic!("unexpected processes response: {other:?}"),
    }
}

/// pid → whether it ends with its Terminal Session.
fn marks(processes: &[ProcessInfo]) -> HashMap<u32, bool> {
    processes
        .iter()
        .map(|p| (p.pid, p.terminal_session_process))
        .collect()
}

#[test]
fn processes_lists_the_shells_session_and_the_descendants_that_left_it() {
    let daemon = start_daemon("processes");
    let (client, rx) = connect(&daemon);
    let shell = create_attached_zsh(&client, "ts-1");
    let nohup = type_and_read_pid(
        &client,
        &rx,
        "ts-1",
        "nohup sleep 600 >/dev/null 2>&1 & echo nohup-pid-$!",
        "nohup-pid-",
    );
    // The parent stays as the shell's job, the way claude's Bash tool keeps a background command.
    let escaped = type_and_read_pid(
        &client,
        &rx,
        "ts-1",
        "perl -MPOSIX -e 'if (my $p = fork) { print \"setsid-pid-$p\\n\"; waitpid $p, 0; exit } \
         POSIX::setsid(); open STDIN, \"</dev/null\"; open STDOUT, \">/dev/null\"; \
         open STDERR, \">/dev/null\"; exec \"sleep\", \"600\"' &",
        "setsid-pid-",
    );
    let _strays = Strays(vec![nohup, escaped]);

    let mut before = HashMap::new();
    wait_until(Duration::from_secs(5), || {
        before = marks(&processes(&client, "ts-1"));
        before.get(&escaped) == Some(&false)
    });
    assert_eq!(before.get(&shell), Some(&true), "the shell: {before:?}");
    assert_eq!(
        before.get(&nohup),
        Some(&true),
        "the nohup child: {before:?}"
    );

    client
        .request(RequestOp::Terminate {
            session_id: "ts-1".into(),
        })
        .unwrap();
    wait_for_exit(&rx, "ts-1");
    let waiting = marks(&processes(&client, "ts-1"));
    assert_eq!(
        waiting.get(&nohup),
        Some(&true),
        "the nohup child waits for the cleanup: {waiting:?}"
    );

    wait_until(Duration::from_secs(10), || !process_alive(nohup));
    let after = processes(&client, "ts-1");
    assert!(
        after.iter().all(|p| !p.terminal_session_process),
        "after the cleanup: {after:?}"
    );
}

#[test]
fn a_write_from_a_connection_that_never_attached_reaches_the_shell() {
    let daemon = start_daemon("write-unattached");
    let (writer, _writer_rx) = connect(&daemon);
    create_zsh_session(&writer, "ts-1").expect("unix spawns should expose a pid");

    writer
        .notify(RequestOp::Write {
            session_id: "ts-1".into(),
            data: b64(b"echo unattached-$((6*7))\r"),
        })
        .unwrap();

    let (viewer, viewer_rx) = connect(&daemon);
    let replay = match viewer
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
    if !replay.contains("unattached-42") {
        wait_for_output(&viewer_rx, "unattached-42", Duration::from_secs(10));
    }
}

#[test]
fn a_shell_asked_to_start_in_a_missing_directory_starts_in_home() {
    let daemon = start_daemon("missing-cwd");
    let user_home = daemon.dir.join("user");
    std::fs::create_dir_all(&user_home).unwrap();
    let user_home = std::fs::canonicalize(&user_home).unwrap();
    let (client, rx) = connect(&daemon);
    client
        .request(RequestOp::Create(CreateParams {
            session_id: "ts-1".to_string(),
            cwd: daemon
                .dir
                .join("removed-worktree")
                .to_string_lossy()
                .to_string(),
            shell: Some("/bin/zsh".to_string()),
            rows: 24,
            cols: 80,
            env: Some(vec![(
                "HOME".to_string(),
                user_home.to_string_lossy().to_string(),
            )]),
        }))
        .expect("create should succeed");
    client
        .request(RequestOp::Attach {
            session_id: "ts-1".into(),
            replay_bytes: None,
        })
        .unwrap();

    client
        .notify(RequestOp::Write {
            session_id: "ts-1".into(),
            data: b64(b"print -r -- \"cwd:$(pwd -P):$((1+1))\"\r"),
        })
        .unwrap();

    wait_for_output(
        &rx,
        &format!("cwd:{}:2", user_home.display()),
        Duration::from_secs(10),
    );
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
        .arg("--monica-home")
        .arg(&daemon.dir)
        .status()
        .expect("second daemon should run");
    assert!(status.success(), "pid-locked duplicate must exit 0");

    // The original daemon must still be serving.
    let (client, _rx) = connect(&daemon);
    assert_eq!(client.hello().unwrap(), PROTOCOL_VERSION);
}

#[test]
fn without_monica_home_the_daemon_lives_in_dot_monica_under_home() {
    let user_home = fresh_dir("default-home");
    let mut command = daemon_command();
    command.env("HOME", &user_home).env_remove("MONICA_HOME");
    let socket = user_home.join(".monica").join("ptyd.sock");
    let daemon = spawn_daemon(command, user_home, socket);

    let (client, _rx) = connect(&daemon);
    assert_eq!(client.hello().unwrap(), PROTOCOL_VERSION);
}

#[test]
fn closing_a_remote_view_keeps_the_desktop_connection_and_pty_size_running() {
    let daemon = start_daemon("remote-close");
    let (desktop, output) = connect(&daemon);
    let pid = create_attached_zsh(&desktop, "shared");
    desktop
        .notify(RequestOp::Resize {
            session_id: "shared".into(),
            rows: 31,
            cols: 97,
        })
        .unwrap();
    let (remote, remote_output) = connect(&daemon);
    remote
        .request(RequestOp::Attach {
            session_id: "shared".into(),
            replay_bytes: None,
        })
        .unwrap();
    remote.close().unwrap();
    assert!(remote_output
        .try_iter()
        .any(|e| matches!(e, ClientEvent::Disconnected)));
    assert!(process_alive(pid));
    match desktop.request(RequestOp::List).unwrap() {
        ResponseBody::Sessions { sessions } => {
            let session = &sessions[0];
            assert!(session.running);
            assert_eq!((session.rows, session.cols), (31, 97));
        }
        other => panic!("unexpected list: {other:?}"),
    }
    desktop
        .notify(RequestOp::Write {
            session_id: "shared".into(),
            data: b64(b"echo desktop-continues-$((6*7))\r"),
        })
        .unwrap();
    wait_for_output(&output, "desktop-continues-42", Duration::from_secs(10));
    desktop.close().unwrap();
}
