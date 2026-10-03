use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use shared_child::unix::SharedChildExt;
use shared_child::SharedChild;
use tauri::{AppHandle, Emitter, Manager};

use crate::announcement::{self, Announcement, Endpoint};
use crate::orphan;
use crate::respawn::Respawn;
use crate::sibling;

const GRACE: Duration = Duration::from_secs(2);

/// Backend の spawn と監督（ADR-0007）。
pub struct Supervisor {
    home: PathBuf,
    state: Mutex<State>,
}

struct State {
    running: Option<Running>,
    endpoint: Option<Endpoint>,
    respawn: Respawn,
    supervising: bool,
    stopping: bool,
}

struct Running {
    child: Arc<SharedChild>,
    // write 側を握ったまま何も書かない。Shell が死ぬと閉じ、Backend は stdin の EOF で抜ける。
    _stdin: ChildStdin,
}

impl Supervisor {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            state: Mutex::new(State {
                running: None,
                endpoint: None,
                respawn: Respawn::new(),
                supervising: false,
                stopping: false,
            }),
        }
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.state.lock().unwrap().endpoint.clone()
    }

    /// SIGTERM を送り、抜けなければ SIGKILL する。以降は respawn しない。
    pub fn stop(&self) {
        let child = {
            let mut state = self.state.lock().unwrap();
            state.stopping = true;
            state.running.as_ref().map(|running| running.child.clone())
        };
        let Some(child) = child else { return };
        let _ = child.send_signal(libc::SIGTERM);
        if !matches!(child.wait_timeout(GRACE), Ok(Some(_))) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn spawn(&self, app: &AppHandle) -> std::io::Result<Option<Arc<SharedChild>>> {
        let mut state = self.state.lock().unwrap();
        // stop() と競っても、止めた後に新しい Backend を残さない。
        if state.stopping {
            return Ok(None);
        }
        let child = Arc::new(SharedChild::spawn(&mut command(&self.home))?);
        let stdin = child.take_stdin().expect("stdin is piped");
        let stdout = child.take_stdout().expect("stdout is piped");
        state.running = Some(Running { child: child.clone(), _stdin: stdin });
        relay(app.clone(), stdout, child.clone());
        Ok(Some(child))
    }
}

pub fn start(app: &AppHandle) {
    {
        let mut state = app.state::<Supervisor>().inner().state.lock().unwrap();
        if state.supervising || state.stopping {
            return;
        }
        state.supervising = true;
    }
    let app = app.clone();
    thread::spawn(move || supervise(&app));
}

pub fn restart(app: &AppHandle) {
    app.state::<Supervisor>().state.lock().unwrap().respawn.reset();
    start(app);
}

fn supervise(app: &AppHandle) {
    let supervisor = app.state::<Supervisor>();
    loop {
        orphan::reap(&supervisor.home);
        match supervisor.spawn(app) {
            Ok(Some(child)) => {
                let status = child.wait();
                eprintln!("[shell] the Backend exited: {status:?}");
            }
            Ok(None) => {}
            Err(error) => eprintln!("[shell] failed to spawn the Backend: {error}"),
        }
        let mut state = supervisor.state.lock().unwrap();
        state.running = None;
        if state.stopping {
            state.supervising = false;
            return;
        }
        // emit は lock の中で行い、endpoint の event が state と同じ順で webview に届くようにする。
        state.endpoint = None;
        let _ = app.emit("backend-endpoint", None::<Endpoint>);
        let Some(delay) = state.respawn.after_failure(Instant::now()) else {
            state.supervising = false;
            eprintln!("[shell] giving up on the Backend after repeated failures");
            let _ = app.emit("backend-failed", ());
            return;
        };
        drop(state);
        thread::sleep(delay);
    }
}

fn relay(app: AppHandle, stdout: ChildStdout, child: Arc<SharedChild>) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(Announcement::Endpoint(endpoint)) = announcement::parse(&line) else {
                eprintln!("[shell] unrecognized Backend stdout: {line}");
                continue;
            };
            let supervisor = app.state::<Supervisor>();
            let mut state = supervisor.state.lock().unwrap();
            // 終わった Backend の書き残しで、次の Backend の endpoint を上書きしない。
            if !state.running.as_ref().is_some_and(|running| Arc::ptr_eq(&running.child, &child)) {
                continue;
            }
            state.endpoint = Some(endpoint.clone());
            let _ = app.emit("backend-endpoint", Some(endpoint));
        }
    });
}

fn command(home: &Path) -> Command {
    let mut command = if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command.arg("--watch").arg(repo().join("apps/backend/src/main.ts"));
        command
    } else {
        Command::new(sibling("tania-backend"))
    };
    command
        .env("TANIA_HOME", home)
        .env("TANIA_PTYD_PATH", ptyd_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        // 端末の Ctrl-C を Backend が直接受けて backend.json を残したまま死なないよう、Shell の死は stdin の EOF で知らせる。
        .process_group(0);
    command
}

fn ptyd_path() -> PathBuf {
    if cfg!(debug_assertions) {
        std::env::var_os("TANIA_PTYD_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| repo().join("target/debug/tania-ptyd"))
    } else {
        sibling("tania-ptyd")
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
