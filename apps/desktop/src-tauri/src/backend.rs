use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use monica_logfile::DailyLog;
use serde::Serialize;
use shared_child::unix::SharedChildExt;
use shared_child::SharedChild;
use tauri::{AppHandle, Emitter, Manager};

use crate::announcement::{self, Announcement, Endpoint, Unread};
use crate::notification::UnreadNotifications;
use crate::respawn::Respawn;
use crate::{locations, notification, orphan, STOP_GRACE};

pub struct Supervisor {
    home: PathBuf,
    log: Option<Arc<DailyLog>>,
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
    notifications: UnreadNotifications,
    _remote: Option<monica_terminal_client::remote::RemoteServer>,
}

impl Supervisor {
    pub fn new(home: PathBuf) -> Self {
        let log = DailyLog::open(&home.join("logs"), "backend")
            .inspect_err(|error| eprintln!("[shell] failed to open the Backend log: {error:#}"))
            .ok()
            .map(Arc::new);
        Self {
            home,
            log,
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
            // 数は起き直した Backend が書き直すので、居ない間は古い数を残さない。
            show_badge(app, None);
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
        let remote = monica_terminal_client::remote::RemoteServer::start(
            self.home.join("ptyd.sock"),
            app.state::<crate::ptyd::PtydHandle>().sizes.clone(),
            app.state::<crate::ptyd::PtydHandle>().renderers.clone(),
        )
        .inspect_err(|error| eprintln!("[shell] remote byte socket unavailable: {error}"))
        .ok();
        let mut command = command(&self.home);
        command
            .env_remove("MONICA_SHELL_SOCKET")
            .env_remove("MONICA_SHELL_SECRET");
        if let Some(remote) = &remote {
            command
                .env("MONICA_SHELL_SOCKET", &remote.path)
                .env("MONICA_SHELL_SECRET", remote.secret());
        }
        let child = Arc::new(SharedChild::spawn(&mut command)?);
        let stdin = child.take_stdin().expect("stdin is piped");
        let stdout = child.take_stdout().expect("stdout is piped");
        let stderr = child.take_stderr().expect("stderr is piped");
        state.running = Some(Running {
            child: child.clone(),
            _stdin: stdin,
            notifications: UnreadNotifications::default(),
            _remote: remote,
        });
        relay(app.clone(), stdout, child.clone());
        let log = self.log.clone();
        thread::spawn(move || write_lines(BufReader::new(stderr), log.as_deref()));
        Ok(Some(child))
    }

    fn announce(&self, app: &AppHandle, from: &Arc<SharedChild>, endpoint: Endpoint) {
        let mut state = self.lock();
        // 終わった Backend の書き残しで、次の Backend の endpoint を上書きしない。
        if state.running_from(from).is_none() {
            return;
        }
        state.endpoint = Some(endpoint.clone());
        let _ = app.emit("backend-endpoint", Some(endpoint));
    }

    fn sync_unread(&self, app: &AppHandle, from: &Arc<SharedChild>, unread: Unread) {
        let withdrawal = {
            let mut state = self.lock();
            // 終わった Backend の書き残しで、消した後の Dock に数を戻さず、次の Backend が揃えた通知も取り下げない。
            let Some(running) = state.running_from(from) else {
                return;
            };
            show_badge(app, unread.dock_count());
            running.notifications.next(&unread.terminal_session_ids)
        };
        withdrawal.carry_out();
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

impl State {
    fn running_from(&mut self, child: &Arc<SharedChild>) -> Option<&mut Running> {
        self.running
            .as_mut()
            .filter(|running| Arc::ptr_eq(&running.child, child))
    }
}

fn relay(app: AppHandle, stdout: ChildStdout, child: Arc<SharedChild>) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match announcement::parse(&line) {
                Some(Announcement::Endpoint(endpoint)) => {
                    app.state::<Supervisor>().announce(&app, &child, endpoint);
                }
                Some(Announcement::Notify(notice)) => notification::post(&app, notice),
                Some(Announcement::Unread(unread)) => {
                    app.state::<Supervisor>().sync_unread(&app, &child, unread);
                }
                None => eprintln!("[shell] unrecognized Backend stdout: {line}"),
            }
        }
    });
}

/// 行は desktop の stderr にも出し、端末から起こした dev の desktop で今どおり見えるようにする。
fn write_lines(mut from: impl BufRead, log: Option<&DailyLog>) {
    let mut bytes = Vec::new();
    // UTF-8 でない行で読むのをやめると pipe が詰まり、Backend の stderr への書き込みが止まる。
    while from
        .read_until(b'\n', &mut bytes)
        .is_ok_and(|read| read > 0)
    {
        let line = String::from_utf8_lossy(&bytes);
        let line = line.trim_end_matches('\n');
        eprintln!("{line}");
        if let Some(log) = log {
            let at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            log.append(&format!(
                "[{}.{:03}] {line}",
                at.as_secs(),
                at.subsec_millis()
            ));
        }
        bytes.clear();
    }
}

fn show_badge(app: &AppHandle, count: Option<i64>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.set_badge_count(count) {
        eprintln!("[shell] failed to badge the Dock icon: {error}");
    }
}

fn command(home: &Path) -> Command {
    let mut command = locations::backend();
    command
        .env("MONICA_HOME", home)
        .env("MONICA_PTYD_PATH", locations::ptyd())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 端末の Ctrl-C を Backend が直接受けて backend.json を残したまま死なないよう、Shell の死は stdin の EOF で知らせる。
        .process_group(0);
    if let Some(port) = locations::browser_port() {
        command.env("MONICA_BROWSER_PORT", port);
    }
    if let Some(claude) = locations::claude() {
        command.env("MONICA_CLAUDE_PATH", claude);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_each_backend_stderr_line_to_the_daily_backend_log_after_the_time() {
        let dir = std::env::temp_dir().join(format!("monica-backend-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = DailyLog::open(&dir, "backend").unwrap();
        let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();

        write_lines(
            Cursor::new(b"[backend] one\n[backend] \xff two\n".to_vec()),
            Some(&log),
        );

        let after = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with("backend_") && files[0].ends_with(".log"));
        let text = std::fs::read_to_string(dir.join(&files[0])).unwrap();
        let lines: Vec<(f64, &str)> = text
            .lines()
            .map(|line| {
                let (at, rest) = line.strip_prefix('[').unwrap().split_once("] ").unwrap();
                let (secs, millis) = at.split_once('.').unwrap();
                assert_eq!(millis.len(), 3);
                (format!("{secs}.{millis}").parse().unwrap(), rest)
            })
            .collect();
        assert_eq!(
            lines.iter().map(|(_, rest)| *rest).collect::<Vec<_>>(),
            ["[backend] one", "[backend] \u{fffd} two"],
        );
        for (at, _) in lines {
            assert!(at >= before.as_millis() as f64 / 1000.0 && at <= after.as_secs_f64() + 0.001);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
