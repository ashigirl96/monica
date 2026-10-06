use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Instant;

use serde::Serialize;
use shared_child::unix::SharedChildExt;
use shared_child::SharedChild;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::announcement::{self, Announcement, Endpoint, Notification};
use crate::respawn::Respawn;
use crate::{locations, orphan, STOP_GRACE};

pub struct Supervisor {
    home: PathBuf,
    state: Mutex<State>,
}

/// webview が訊き直せる今の様子。諦めたことも持つのは、`backend-failed` を聞き逃した webview（reload した後など）が再試行を出せるようにするため。
#[derive(Serialize)]
pub struct Status {
    endpoint: Option<Endpoint>,
    failed: bool,
}

struct State {
    running: Option<Running>,
    endpoint: Option<Endpoint>,
    respawn: Respawn,
    supervising: bool,
    failed: bool,
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
                failed: false,
                stopping: false,
            }),
        }
    }

    pub fn status(&self) -> Status {
        let state = self.lock();
        Status {
            endpoint: state.endpoint.clone(),
            failed: state.failed,
        }
    }

    pub fn start(&self, app: &AppHandle) {
        {
            let mut state = self.lock();
            if state.supervising || state.stopping {
                return;
            }
            state.supervising = true;
            state.failed = false;
        }
        let app = app.clone();
        thread::spawn(move || app.state::<Supervisor>().supervise(&app));
    }

    pub fn restart(&self, app: &AppHandle) {
        self.lock().respawn.reset();
        self.start(app);
    }

    /// 以降は respawn しない。
    pub fn stop(&self) {
        let child = {
            let mut state = self.lock();
            state.stopping = true;
            state.running.as_ref().map(|running| running.child.clone())
        };
        let Some(child) = child else { return };
        let _ = child.send_signal(libc::SIGTERM);
        if !matches!(child.wait_timeout(STOP_GRACE), Ok(Some(_))) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn supervise(&self, app: &AppHandle) {
        loop {
            orphan::stop(&self.home);
            match self.spawn(app) {
                Ok(Some(child)) => {
                    let status = child.wait();
                    eprintln!("[shell] the Backend exited: {status:?}");
                }
                Ok(None) => {}
                Err(error) => eprintln!("[shell] failed to spawn the Backend: {error}"),
            }
            let mut state = self.lock();
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
                state.failed = true;
                eprintln!("[shell] giving up on the Backend after repeated failures");
                let _ = app.emit("backend-failed", ());
                return;
            };
            drop(state);
            thread::sleep(delay);
        }
    }

    fn spawn(&self, app: &AppHandle) -> std::io::Result<Option<Arc<SharedChild>>> {
        let mut state = self.lock();
        // stop() と競っても、止めた後に新しい Backend を残さない。
        if state.stopping {
            return Ok(None);
        }
        let child = Arc::new(SharedChild::spawn(&mut command(&self.home))?);
        let stdin = child.take_stdin().expect("stdin is piped");
        let stdout = child.take_stdout().expect("stdout is piped");
        state.running = Some(Running {
            child: child.clone(),
            _stdin: stdin,
        });
        relay(app.clone(), stdout, child.clone());
        Ok(Some(child))
    }

    fn announce(&self, app: &AppHandle, from: &Arc<SharedChild>, endpoint: Endpoint) {
        let mut state = self.lock();
        // 終わった Backend の書き残しで、次の Backend の endpoint を上書きしない。
        if !state
            .running
            .as_ref()
            .is_some_and(|running| Arc::ptr_eq(&running.child, from))
        {
            return;
        }
        state.endpoint = Some(endpoint.clone());
        let _ = app.emit("backend-endpoint", Some(endpoint));
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

fn relay(app: AppHandle, stdout: ChildStdout, child: Arc<SharedChild>) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match announcement::parse(&line) {
                Some(Announcement::Endpoint(endpoint)) => {
                    app.state::<Supervisor>().announce(&app, &child, endpoint);
                }
                Some(Announcement::Notify(notice)) => notify(&app, notice),
                None => eprintln!("[shell] unrecognized Backend stdout: {line}"),
            }
        }
    });
}

fn notify(app: &AppHandle, Notification { title, body }: Notification) {
    let shown = app.notification().builder().title(title).body(body).show();
    if let Err(error) = shown {
        eprintln!("[shell] failed to post a notification: {error}");
    }
}

fn command(home: &Path) -> Command {
    let mut command = locations::backend();
    command
        .env("TANIA_HOME", home)
        .env("TANIA_PTYD_PATH", locations::ptyd())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        // 端末の Ctrl-C を Backend が直接受けて backend.json を残したまま死なないよう、Shell の死は stdin の EOF で知らせる。
        .process_group(0);
    if let Some(port) = locations::notes_port() {
        command.env("TANIA_NOTES_PORT", port);
    }
    command
}
