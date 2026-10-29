use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::prelude::*;
use monica_terminal_client::{
    remote::{RemoteServer, Sizes},
    ClientEvent, PtydClient,
};
use monica_terminal_protocol::{CreateParams, RequestOp, ResponseBody};
use serde_json::{json, Value};

const WAIT: Duration = Duration::from_secs(5);

struct Daemon {
    child: Child,
    home: PathBuf,
}

impl Daemon {
    fn start(name: &str) -> Self {
        let home = PathBuf::from(format!("/tmp/remote-{name}-{}", std::process::id()));
        fs::create_dir(&home).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_monica-ptyd"))
            .args(["--foreground", "--monica-home"])
            .arg(&home)
            .env("HOME", &home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let daemon = Self { child, home };
        let deadline = Instant::now() + WAIT;
        while UnixStream::connect(daemon.home.join("ptyd.sock")).is_err() {
            assert!(Instant::now() < deadline, "daemon did not listen");
            thread::sleep(Duration::from_millis(10));
        }
        daemon
    }

    fn desktop(&self) -> (PtydClient, mpsc::Receiver<ClientEvent>) {
        let (tx, rx) = mpsc::channel();
        let client = PtydClient::connect(&self.home.join("ptyd.sock"), move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        client.hello().unwrap();
        (client, rx)
    }

    fn create(&self, client: &PtydClient) {
        let shell = self.home.join("child");
        fs::write(self.home.join("child.sh"), b"printf 'retained-marker\\n'\nwhile [ ! -e \"$HOME/finish\" ]; do /bin/sleep 0.01; done\nprintf 'final-marker\\n'\nexit 7\n").unwrap();
        std::os::unix::fs::symlink(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/workbench/src/fake-executable.sh"),
            &shell,
        )
        .unwrap();
        client
            .request(RequestOp::Create(CreateParams {
                session_id: "shared".into(),
                cwd: self.home.to_string_lossy().into_owned(),
                shell: Some(shell.to_string_lossy().into_owned()),
                rows: 31,
                cols: 97,
                env: Some(
                    ["HOME", "ZDOTDIR", "MONICA_HOME"]
                        .into_iter()
                        .map(|key| (key.into(), self.home.to_string_lossy().into_owned()))
                        .collect(),
                ),
            }))
            .unwrap();
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn send(stream: &mut UnixStream, value: &Value) {
    writeln!(stream, "{value}").unwrap();
}

fn read(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    assert_ne!(reader.read_line(&mut line).unwrap(), 0, "unexpected EOF");
    serde_json::from_str(&line).unwrap()
}

struct Proxy {
    path: PathBuf,
    hold_next: Arc<AtomicBool>,
    held: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
    messages: mpsc::Receiver<Value>,
    operations: Arc<Mutex<Vec<String>>>,
    streams: Arc<Mutex<Vec<UnixStream>>>,
    worker: Option<JoinHandle<()>>,
}

impl Proxy {
    fn start(daemon: &Daemon, hold_initial: bool) -> Self {
        let path = daemon.home.join("proxy.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let upstream_path = daemon.home.join("ptyd.sock");
        let (held_tx, held) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (message_tx, messages) = mpsc::channel();
        let operations = Arc::new(Mutex::new(Vec::new()));
        let recorded = operations.clone();
        let streams = Arc::new(Mutex::new(Vec::new()));
        let shutdown = streams.clone();
        let hold_next = Arc::new(AtomicBool::new(hold_initial));
        let hold = hold_next.clone();
        let worker = thread::spawn(move || {
            let (mut downstream, _) = listener.accept().unwrap();
            let mut upstream = UnixStream::connect(upstream_path).unwrap();
            shutdown.lock().unwrap().extend([
                downstream.try_clone().unwrap(),
                upstream.try_clone().unwrap(),
            ]);
            let mut responses = BufReader::new(upstream.try_clone().unwrap());
            let mut requests = BufReader::new(downstream.try_clone().unwrap());
            let response_worker = thread::spawn(move || {
                let mut line = String::new();
                while responses.read_line(&mut line).is_ok_and(|n| n > 0) {
                    let value = serde_json::from_str(&line).unwrap();
                    if downstream.write_all(line.as_bytes()).is_err() {
                        break;
                    }
                    let _ = message_tx.send(value);
                    line.clear();
                }
            });
            let mut line = String::new();
            while requests.read_line(&mut line).is_ok_and(|n| n > 0) {
                let value: Value = serde_json::from_str(&line).unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(value["op"].as_str().unwrap().into());
                if value["op"] == "list" && hold.swap(false, Ordering::SeqCst) {
                    let _ = held_tx.send(());
                    if release_rx.recv_timeout(WAIT).is_err() {
                        break;
                    }
                }
                if upstream.write_all(line.as_bytes()).is_err() {
                    break;
                }
                line.clear();
            }
            let _ = upstream.shutdown(Shutdown::Both);
            response_worker.join().unwrap();
        });
        Self {
            path,
            hold_next,
            held,
            release,
            messages,
            operations,
            streams,
            worker: Some(worker),
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        let _ = self.release.send(());
        for stream in self.streams.lock().unwrap().iter() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        self.worker.take().unwrap().join().unwrap();
    }
}

fn output_until_exit(events: &mpsc::Receiver<ClientEvent>) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        match events.recv_timeout(WAIT).unwrap() {
            ClientEvent::Output { data, .. } => bytes.extend(BASE64_STANDARD.decode(data).unwrap()),
            ClientEvent::Exit { exit_code, .. } => {
                assert_eq!(exit_code, Some(7));
                return bytes;
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}

fn exit_during_size_readback(name: &str, later: bool, reap: bool) {
    let daemon = Daemon::start(name);
    let (desktop, events) = daemon.desktop();
    daemon.create(&desktop);
    let mut initial = match desktop
        .request(RequestOp::Attach {
            session_id: "shared".into(),
            replay_bytes: None,
        })
        .unwrap()
    {
        ResponseBody::Attached { replay, .. } => BASE64_STANDARD.decode(replay).unwrap(),
        other => panic!("unexpected attach: {other:?}"),
    };
    while !String::from_utf8_lossy(&initial).contains("retained-marker") {
        if let ClientEvent::Output { data, .. } = events.recv_timeout(WAIT).unwrap() {
            initial.extend(BASE64_STANDARD.decode(data).unwrap());
        }
    }
    let proxy = Proxy::start(&daemon, !later);
    let sizes = Arc::new(Sizes::default());
    let relay = RemoteServer::start(proxy.path.clone(), sizes.clone(), Arc::default()).unwrap();
    let mut phone = UnixStream::connect(&relay.path).unwrap();
    phone
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    let mut reader = BufReader::new(phone.try_clone().unwrap());
    send(
        &mut phone,
        &json!({"secret":relay.secret(), "session":"shared"}),
    );
    let mut frames = Vec::new();
    if later {
        loop {
            let value = read(&mut reader);
            send(
                &mut phone,
                &json!({"type":"ack", "sequence":value["sequence"]}),
            );
            let done = value["type"] == "replay_end";
            frames.push(value);
            if done {
                break;
            }
        }
        sizes.resize(&desktop, "shared".into(), 35, 101).unwrap();
        let value = read(&mut reader);
        assert_eq!(
            (value["rows"].as_u64(), value["cols"].as_u64()),
            (Some(35), Some(101))
        );
        send(
            &mut phone,
            &json!({"type":"ack", "sequence":value["sequence"]}),
        );
        frames.push(value);
        proxy.hold_next.store(true, Ordering::SeqCst);
        sizes.resize(&desktop, "shared".into(), 42, 111).unwrap();
    }
    proxy.held.recv_timeout(WAIT).unwrap();
    fs::write(daemon.home.join("finish"), b"").unwrap();
    assert_eq!(output_until_exit(&events), b"final-marker\r\n");
    if reap {
        desktop
            .request(RequestOp::Reap {
                session_id: "shared".into(),
            })
            .unwrap();
    }
    match desktop.request(RequestOp::List).unwrap() {
        ResponseBody::Sessions { sessions } if reap => assert!(sessions.is_empty()),
        ResponseBody::Sessions { sessions } => {
            assert!(!sessions[0].running);
            assert_eq!((sessions[0].rows, sessions[0].cols), (0, 0));
        }
        other => panic!("unexpected list: {other:?}"),
    }
    let mut observed = Vec::new();
    loop {
        let value = proxy.messages.recv_timeout(WAIT).unwrap();
        let done = value["type"] == "exit";
        observed.push(value);
        if done {
            break;
        }
    }
    let attached = observed.iter().find(|v| v["body"] == "attached").unwrap();
    assert_eq!(
        BASE64_STANDARD
            .decode(attached["replay"].as_str().unwrap())
            .unwrap(),
        b"retained-marker\r\n"
    );
    assert!(observed.iter().any(|v| v["type"] == "output"));
    proxy.release.send(()).unwrap();
    loop {
        let value = read(&mut reader);
        let done = value["type"] == "closed";
        if !done {
            send(
                &mut phone,
                &json!({"type":"ack", "sequence":value["sequence"]}),
            );
        }
        frames.push(value);
        if done {
            break;
        }
    }
    let types: Vec<_> = frames.iter().map(|v| v["type"].as_str().unwrap()).collect();
    let expected = if later {
        vec![
            "size",
            "output",
            "replay_end",
            "size",
            "output",
            "exit",
            "closed",
        ]
    } else {
        vec!["size", "output", "replay_end", "output", "exit", "closed"]
    };
    assert_eq!(
        types, expected,
        "all retained bytes and Exit must drain before close"
    );
    let grids: Vec<_> = frames
        .iter()
        .filter(|v| v["type"] == "size")
        .map(|v| (v["rows"].as_u64().unwrap(), v["cols"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        grids,
        if later {
            vec![(31, 97), (35, 101)]
        } else {
            vec![(31, 97)]
        }
    );
    let bytes: Vec<u8> = frames
        .iter()
        .filter(|v| v["type"] == "output")
        .flat_map(|v| BASE64_STANDARD.decode(v["data"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(bytes, b"retained-marker\r\nfinal-marker\r\n");
    assert_eq!(frames[frames.len() - 2]["exitCode"], 7);
    for (index, value) in frames[..frames.len() - 1].iter().enumerate() {
        assert_eq!(value["sequence"], index + 1);
    }
    assert!(proxy
        .operations
        .lock()
        .unwrap()
        .iter()
        .all(|op| matches!(op.as_str(), "hello" | "attach" | "list")));
    desktop.close().unwrap();
}

#[test]
fn initial_readback_of_a_tombstone_preserves_attach_grid_replay_live_and_exit() {
    exit_during_size_readback("initial-exit", false, false);
}

#[test]
fn initial_readback_after_reap_preserves_attach_grid_replay_live_and_exit() {
    exit_during_size_readback("initial-reap", false, true);
}

#[test]
fn later_readback_of_a_tombstone_preserves_confirmed_grid_and_drains_exit() {
    exit_during_size_readback("later-exit", true, false);
}

#[test]
fn later_readback_after_reap_preserves_confirmed_grid_and_drains_exit() {
    exit_during_size_readback("later-reap", true, true);
}

#[test]
fn attach_replay_limits_and_exited_session_rejection_match_the_protocol() {
    let daemon = Daemon::start("attach-boundary");
    let (desktop, events) = daemon.desktop();
    daemon.create(&desktop);
    let mut retained = match desktop
        .request(RequestOp::Attach {
            session_id: "shared".into(),
            replay_bytes: None,
        })
        .unwrap()
    {
        ResponseBody::Attached { replay, .. } => BASE64_STANDARD.decode(replay).unwrap(),
        other => panic!("unexpected attach: {other:?}"),
    };
    while !String::from_utf8_lossy(&retained).contains("retained-marker") {
        if let ClientEvent::Output { data, .. } = events.recv_timeout(WAIT).unwrap() {
            retained.extend(BASE64_STANDARD.decode(data).unwrap());
        }
    }
    for (limit, expected) in [
        (Some(0), b"".as_slice()),
        (Some(6), b"rker\r\n"),
        (None, b"retained-marker\r\n"),
    ] {
        let (viewer, _) = daemon.desktop();
        match viewer
            .request(RequestOp::Attach {
                session_id: "shared".into(),
                replay_bytes: limit,
            })
            .unwrap()
        {
            ResponseBody::Attached { replay, rows, cols } => {
                assert_eq!(BASE64_STANDARD.decode(replay).unwrap(), expected);
                assert_eq!((rows, cols), (31, 97));
            }
            other => panic!("unexpected attach: {other:?}"),
        }
        viewer.close().unwrap();
    }
    fs::write(daemon.home.join("finish"), b"").unwrap();
    assert_eq!(output_until_exit(&events), b"final-marker\r\n");
    let (viewer, _) = daemon.desktop();
    let error = viewer
        .request(RequestOp::Attach {
            session_id: "shared".into(),
            replay_bytes: None,
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "daemon error: session shared has exited");
    viewer.close().unwrap();
    desktop.close().unwrap();
}

#[test]
fn fake_shell_uses_the_shared_launcher_and_a_nonexecutable_profile() {
    let daemon = Daemon::start("shell-launcher");
    let (desktop, _) = daemon.desktop();
    daemon.create(&desktop);
    let shell = daemon.home.join("child");
    assert_eq!(
        fs::read_link(&shell).unwrap(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/workbench/src/fake-executable.sh")
    );
    assert_eq!(
        fs::metadata(daemon.home.join("child.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    desktop.close().unwrap();
}

#[test]
fn small_echo_bursts_keep_remote_input_and_both_views_on_the_existing_pty() {
    let daemon = Daemon::start("input-burst");
    let (desktop, events) = daemon.desktop();
    let shell = daemon.home.join("input-child");
    fs::write(daemon.home.join("input-child.sh"), b"stty -echo\nprintf 'ready\\n'\nread value\nprintf 'first\\n'\nwhile [ ! -e \"$HOME/burst\" ]; do /bin/sleep 0.01; done\ni=0; while [ $i -lt 5000 ]; do printf x; i=$((i+1)); done\nprintf '\\nresult:%s\\n' \"$value\"\nwhile [ ! -e \"$HOME/finish\" ]; do /bin/sleep 0.01; done\n").unwrap();
    std::os::unix::fs::symlink(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/workbench/src/fake-executable.sh"),
        &shell,
    )
    .unwrap();
    desktop
        .request(RequestOp::Create(CreateParams {
            session_id: "shared".into(),
            cwd: daemon.home.to_string_lossy().into_owned(),
            shell: Some(shell.to_string_lossy().into_owned()),
            rows: 31,
            cols: 97,
            env: Some(
                ["HOME", "ZDOTDIR", "MONICA_HOME"]
                    .into_iter()
                    .map(|key| (key.into(), daemon.home.to_string_lossy().into_owned()))
                    .collect(),
            ),
        }))
        .unwrap();
    desktop
        .request(RequestOp::Attach {
            session_id: "shared".into(),
            replay_bytes: None,
        })
        .unwrap();
    let renderers = Arc::new(monica_terminal_client::renderer::Renderers::default());
    let generation = renderers.register("shared");
    renderers.parsed("shared", generation, 0, Instant::now());
    let relay = RemoteServer::start(
        daemon.home.join("ptyd.sock"),
        Arc::default(),
        renderers.clone(),
    )
    .unwrap();
    let mut phone = UnixStream::connect(&relay.path).unwrap();
    phone.set_read_timeout(Some(WAIT)).unwrap();
    let mut reader = BufReader::new(phone.try_clone().unwrap());
    send(
        &mut phone,
        &json!({"secret":relay.secret(),"session":"shared"}),
    );
    loop {
        let frame = read(&mut reader);
        send(
            &mut phone,
            &json!({"type":"ack","sequence":frame["sequence"]}),
        );
        if frame["type"] == "replay_end" {
            break;
        }
    }
    send(
        &mut phone,
        &json!({"type":"input","id":1,"generation":generation,"data":BASE64_STANDARD.encode(b"same-input\n")}),
    );
    let mut remote_bytes = Vec::new();
    let mut held = None;
    let mut accepted = false;
    while held.is_none() || !accepted {
        let frame = read(&mut reader);
        if frame["type"] == "input_result" {
            assert_eq!(frame["result"], "accepted");
            accepted = true;
        } else {
            assert_eq!(frame["type"], "output");
            remote_bytes.extend(
                BASE64_STANDARD
                    .decode(frame["data"].as_str().unwrap())
                    .unwrap(),
            );
            if String::from_utf8_lossy(&remote_bytes).contains("first") {
                held = Some(frame["sequence"].clone());
            } else {
                send(
                    &mut phone,
                    &json!({"type":"ack","sequence":frame["sequence"]}),
                );
            }
        }
    }
    fs::write(daemon.home.join("burst"), b"").unwrap();
    let mut desktop_bytes = Vec::new();
    while !String::from_utf8_lossy(&desktop_bytes).contains("result:same-input") {
        if let ClientEvent::Output { data, .. } = events.recv_timeout(WAIT).unwrap() {
            desktop_bytes.extend(BASE64_STANDARD.decode(data).unwrap());
        }
    }
    send(&mut phone, &json!({"type":"ack","sequence":held.unwrap()}));
    while !String::from_utf8_lossy(&remote_bytes).contains("result:same-input") {
        let frame = read(&mut reader);
        assert_eq!(
            frame["type"], "output",
            "small bursts must not exhaust a byte-bounded queue"
        );
        remote_bytes.extend(
            BASE64_STANDARD
                .decode(frame["data"].as_str().unwrap())
                .unwrap(),
        );
        send(
            &mut phone,
            &json!({"type":"ack","sequence":frame["sequence"]}),
        );
    }
    assert_eq!(
        remote_bytes.iter().filter(|&&byte| byte == b'x').count(),
        5000
    );
    assert_eq!(
        desktop_bytes.iter().filter(|&&byte| byte == b'x').count(),
        5000
    );
    send(&mut phone, &json!({"type":"close"}));
    assert_eq!(read(&mut reader)["type"], "closed");
    match desktop.request(RequestOp::List).unwrap() {
        ResponseBody::Sessions { sessions } => {
            assert!(sessions[0].running);
            assert_eq!((sessions[0].rows, sessions[0].cols), (31, 97));
        }
        other => panic!("unexpected list {other:?}"),
    }
    desktop.close().unwrap();
}
