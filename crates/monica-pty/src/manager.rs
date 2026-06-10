use std::collections::HashMap;
use std::io::Read;
use std::sync::{mpsc, Arc, Mutex};

use anyhow::{bail, Context};
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder};

use crate::session::PtySession;
use crate::types::{PtyOutput, PtySize, SpawnRequest};

const READ_BUF_SIZE: usize = 16384;
const BATCH_QUEUE_CAP: usize = 32;

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn(
        &self,
        req: SpawnRequest,
        output_sink: impl Fn(PtyOutput) + Send + 'static,
        exit_sink: impl Fn(String, Option<u32>) + Send + 'static,
    ) -> anyhow::Result<()> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(portable_pty::PtySize {
                rows: req.rows,
                cols: req.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open pty")?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        // Drop direnv state inherited from the shell that launched the app. With a stale
        // DIRENV_DIFF, direnv in the new tab "reverts" vars recorded there (e.g. MONICA_HOME
        // exported by a repo .envrc) and silently strips them from the session env.
        for key in ["DIRENV_DIFF", "DIRENV_DIR", "DIRENV_FILE", "DIRENV_WATCHES"] {
            cmd.env_remove(key);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "WezTerm");
        cmd.env(
            "LANG",
            std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string()),
        );
        if let Some(ref extra_env) = req.env {
            for (key, value) in extra_env {
                cmd.env(key, value);
            }
        }
        cmd.arg("--login");
        let cwd = if let Some(rest) = req.cwd.strip_prefix("~/") {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
            format!("{home}/{rest}")
        } else if req.cwd == "~" {
            std::env::var("HOME").unwrap_or_else(|_| req.cwd.clone())
        } else {
            req.cwd.clone()
        };
        cmd.cwd(&cwd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn shell")?;

        let reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone pty reader")?;

        let writer = pair
            .master
            .take_writer()
            .context("failed to take pty writer")?;

        let mut killer = child.clone_killer();

        let id_for_reader = req.id.clone();
        let id_for_exit = req.id.clone();
        let sessions_for_exit = Arc::clone(&self.sessions);

        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(BATCH_QUEUE_CAP);

        let cleanup = |killer: &mut dyn portable_pty::ChildKiller| {
            let _ = killer.kill();
        };

        let reader_handle = std::thread::Builder::new()
            .name(format!("pty-reader-{}", &id_for_reader))
            .spawn(move || {
                reader_loop(reader, tx);
            });
        if let Err(e) = reader_handle {
            cleanup(&mut *killer);
            return Err(e).context("failed to spawn reader thread");
        }

        let emitter_handle = std::thread::Builder::new()
            .name(format!("pty-emitter-{}", &id_for_reader))
            .spawn(move || {
                emitter_loop(&id_for_reader, rx, &output_sink);
            });
        if let Err(e) = emitter_handle {
            cleanup(&mut *killer);
            return Err(e).context("failed to spawn emitter thread");
        }

        let wait_handle = std::thread::Builder::new()
            .name(format!("pty-wait-{}", &id_for_exit))
            .spawn(move || {
                let exit_code = wait_for_child(child);
                {
                    if let Ok(mut sessions) = sessions_for_exit.lock() {
                        sessions.remove(&id_for_exit);
                    }
                }
                exit_sink(id_for_exit, exit_code);
            });
        if let Err(e) = wait_handle {
            cleanup(&mut *killer);
            return Err(e).context("failed to spawn wait thread");
        }

        let session = PtySession::new(pair.master, writer, killer);
        {
            let mut sessions = self.sessions.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
            sessions.insert(req.id.clone(), session);
        }

        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        match sessions.get(id) {
            Some(session) => session.write(data),
            None => bail!("no pty session with id: {id}"),
        }
    }

    pub fn resize(&self, id: &str, size: PtySize) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        match sessions.get(id) {
            Some(session) => session.resize(size.rows, size.cols),
            None => bail!("no pty session with id: {id}"),
        }
    }

    pub fn kill(&self, id: &str) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        match sessions.get(id) {
            Some(session) => session.kill(),
            None => Ok(()),
        }
    }

    pub fn is_alive(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .map(|s| s.contains_key(id))
            .unwrap_or(false)
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for (_, session) in sessions.iter() {
                let _ = session.kill();
            }
        }
    }
}

fn reader_loop(mut reader: Box<dyn Read + Send>, tx: mpsc::SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; READ_BUF_SIZE];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(e) => {
                log::debug!("pty reader error: {e}");
                break;
            }
        }
    }
}

fn emitter_loop(id: &str, rx: mpsc::Receiver<Vec<u8>>, sink: &impl Fn(PtyOutput)) {
    let engine = base64::engine::general_purpose::STANDARD;
    for chunk in rx {
        let data = engine.encode(&chunk);
        sink(PtyOutput {
            id: id.to_string(),
            data,
        });
    }
}

fn wait_for_child(mut child: Box<dyn portable_pty::Child + Send + Sync>) -> Option<u32> {
    match child.wait() {
        Ok(status) => {
            if status.success() {
                Some(0)
            } else {
                // portable-pty ExitStatus doesn't expose the code directly on all platforms
                Some(1)
            }
        }
        Err(e) => {
            log::warn!("error waiting for pty child: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_echo_and_read_output() {
        let manager = PtyManager::new();

        let (output_tx, output_rx) = std_mpsc::channel::<PtyOutput>();
        let (exit_tx, exit_rx) = std_mpsc::channel::<(String, Option<u32>)>();

        let id = "test-session-1".to_string();
        manager
            .spawn(
                SpawnRequest {
                    id: id.clone(),
                    cwd: std::env::temp_dir().to_string_lossy().to_string(),
                    rows: 24,
                    cols: 80,
                    env: None,
                },
                move |output| {
                    let _ = output_tx.send(output);
                },
                move |id, code| {
                    let _ = exit_tx.send((id, code));
                },
            )
            .expect("spawn should succeed");

        assert!(manager.is_alive(&id));

        let engine = base64::engine::general_purpose::STANDARD;
        let input = engine.encode(b"echo hello-monica\r\nexit\r\n");
        let decoded = engine.decode(&input).unwrap();
        manager.write(&id, &decoded).expect("write should succeed");

        let mut combined = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match output_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(output) => {
                    let bytes = engine.decode(&output.data).unwrap();
                    combined.push_str(&String::from_utf8_lossy(&bytes));
                    if combined.contains("hello-monica") {
                        break;
                    }
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }

        assert!(
            combined.contains("hello-monica"),
            "expected 'hello-monica' in output, got: {combined}"
        );

        let (exit_id, exit_code) = exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(exit_id, id);
        assert_eq!(exit_code, Some(0));

        assert!(!manager.is_alive(&id));
    }

    #[test]
    fn resize_session() {
        let manager = PtyManager::new();

        let id = "test-resize".to_string();
        manager
            .spawn(
                SpawnRequest {
                    id: id.clone(),
                    cwd: std::env::temp_dir().to_string_lossy().to_string(),
                    rows: 24,
                    cols: 80,
                    env: None,
                },
                |_| {},
                |_, _| {},
            )
            .expect("spawn should succeed");

        manager
            .resize(&id, PtySize { rows: 40, cols: 120 })
            .expect("resize should succeed");

        manager.kill(&id).expect("kill should succeed");
    }

    #[test]
    fn kill_session() {
        let manager = PtyManager::new();

        let (exit_tx, exit_rx) = std_mpsc::channel();
        let id = "test-kill".to_string();
        manager
            .spawn(
                SpawnRequest {
                    id: id.clone(),
                    cwd: std::env::temp_dir().to_string_lossy().to_string(),
                    rows: 24,
                    cols: 80,
                    env: None,
                },
                |_| {},
                move |id, code| {
                    let _ = exit_tx.send((id, code));
                },
            )
            .expect("spawn should succeed");

        assert!(manager.is_alive(&id));
        manager.kill(&id).expect("kill should succeed");

        let _ = exit_rx.recv_timeout(Duration::from_secs(3));
    }

    #[test]
    fn write_to_nonexistent_session_fails() {
        let manager = PtyManager::new();
        let result = manager.write("nonexistent", b"hello");
        assert!(result.is_err());
    }
}
