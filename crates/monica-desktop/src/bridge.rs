//! browser-bridge sidecar のプロセス管理。ptyd と違い bridge は app と同寿命:
//! `BridgeHandle` が `Child` を単独所有し、設定変更で kill→respawn、
//! `RunEvent::Exit` で確実に殺す。設定は bridge 自身が settings.json を読むので
//! ここは値を渡さない（single source of truth は設定ファイル）。

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use monica_paths as paths;
use tauri::{AppHandle, Manager};

const LOG_FILE_NAME: &str = "browser-bridge.log";
/// bind 失敗等の即死を検知するまでの猶予。長すぎると起動失敗の warn が遅れるだけ。
const EARLY_EXIT_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Default)]
pub struct BridgeHandle {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    // generation は early-exit watcher の世代照合用: 猶予中に respawn が起きたとき、
    // watcher が別世代の Child を誤って報告しないようにする
    child: Mutex<Option<(u64, Child)>>,
    generation: AtomicU64,
}

impl BridgeHandle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self) -> Result<()> {
        let base = paths::base_dir()?;
        kill_stale_bridge();

        let logs_dir = paths::logs_dir()?;
        std::fs::create_dir_all(&logs_dir)
            .with_context(|| format!("failed to create {}", logs_dir.display()))?;
        let log_path = logs_dir.join(LOG_FILE_NAME);
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open {}", log_path.display()))?;
        let stderr_file = log_file.try_clone().context("failed to clone log handle")?;

        let binary = bridge_binary();
        let child = Command::new(&binary)
            .arg("--monica-home")
            .arg(&base)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(stderr_file))
            .spawn()
            .with_context(|| format!("failed to spawn {}", binary.display()))?;

        if let Ok(pid_path) = paths::browser_bridge_pid_path() {
            if let Err(e) = std::fs::write(&pid_path, child.id().to_string()) {
                log::warn!(target: "monica_app::bridge", "failed to write pid file: {e}");
            }
        }

        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut guard = self
                .inner
                .child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((_, mut old)) = guard.take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            *guard = Some((generation, child));
        }

        log::info!(target: "monica_app::bridge", "browser-bridge spawned (logs: {})", log_path.display());
        self.watch_early_exit(generation);
        Ok(())
    }

    pub fn stop(&self) {
        let taken = self
            .inner
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some((_, mut child)) = taken {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(pid_path) = paths::browser_bridge_pid_path() {
            let _ = std::fs::remove_file(&pid_path);
        }
    }

    /// 設定変更の反映: 常に落としてから enabled のときだけ起動し直す。
    pub fn apply(&self, enabled: bool) -> Result<()> {
        self.stop();
        if enabled { self.start() } else { Ok(()) }
    }

    pub fn is_running(&self) -> bool {
        let mut guard = match self.inner.child.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        match guard.as_mut() {
            Some((_, child)) => match child.try_wait() {
                Ok(None) => true,
                // 自発 exit した zombie をここで回収する
                Ok(Some(_)) | Err(_) => {
                    guard.take();
                    false
                }
            },
            None => false,
        }
    }

    fn watch_early_exit(&self, generation: u64) {
        let inner = self.inner.clone();
        let spawned = std::thread::Builder::new()
            .name("browser-bridge-watch".to_string())
            .spawn(move || {
                std::thread::sleep(EARLY_EXIT_GRACE);
                let mut guard = match inner.child.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                let Some((gen, child)) = guard.as_mut() else {
                    return;
                };
                if *gen != generation {
                    return;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    log::warn!(
                        target: "monica_app::bridge",
                        "browser-bridge exited early ({status}) — port conflict? see logs/{LOG_FILE_NAME}",
                    );
                    guard.take();
                    if let Ok(pid_path) = paths::browser_bridge_pid_path() {
                        let _ = std::fs::remove_file(&pid_path);
                    }
                }
            });
        if let Err(e) = spawned {
            log::warn!(target: "monica_app::bridge", "failed to start early-exit watcher: {e}");
        }
    }
}

/// 起動時の自動 spawn。設定が読めない・disabled なら何もしない。
pub(crate) fn start_if_enabled(app: &AppHandle) {
    let settings = paths::base_dir().and_then(|base| monica_settings::Settings::load_from(&base));
    match settings {
        Ok(settings) if settings.translate.enabled => {
            if let Err(e) = app.state::<BridgeHandle>().start() {
                log::warn!(target: "monica_app::bridge", "failed to start browser-bridge: {e:#}");
            }
        }
        Ok(_) => {
            log::info!(target: "monica_app::bridge", "translate disabled; browser-bridge not started");
        }
        Err(e) => {
            log::warn!(target: "monica_app::bridge", "failed to load settings; browser-bridge not started: {e:#}");
        }
    }
}

fn bridge_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("MONICA_BROWSER_BRIDGE_PATH") {
        return PathBuf::from(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri externalBin lands next to the app binary (Contents/MacOS/).
            let bundled = dir.join("monica-browser-bridge");
            if bundled.exists() {
                return bundled;
            }
        }
    }
    PathBuf::from("monica-browser-bridge")
}

/// 前回の app が RunEvent::Exit を踏めず（SIGKILL・クラッシュ）bridge が残った場合の回収。
/// cold start では pid が無関係のプロセスに再割当されている可能性があるので、
/// comm 名が bridge のときだけ SIGTERM する。
fn kill_stale_bridge() {
    let Ok(pid_path) = paths::browser_bridge_pid_path() else {
        return;
    };
    let Ok(contents) = std::fs::read_to_string(&pid_path) else {
        return;
    };
    let _ = std::fs::remove_file(&pid_path);
    let Ok(pid) = contents.trim().parse::<u32>() else {
        return;
    };
    let comm = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output();
    let is_bridge = comm
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("monica-browser-bridge"))
        .unwrap_or(false);
    if is_bridge {
        let _ = Command::new("/bin/kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
}
