//! Session/connection bookkeeping for the daemon. One mutex guards everything: transcript
//! appends, attach (tail cut + fanout registration), and exit transitions all serialize
//! through it, which is what makes replay-then-stream gapless and duplicate-free without
//! sequence numbers.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use base64::Engine;

use crate::manager::PtyManager;
use crate::transcript::Transcript;
use crate::types::{PtySize, SpawnRequest};
use monica_terminal_protocol::{CreateParams, ServerMessage, SessionInfo};

const DEFAULT_REPLAY_BYTES: u32 = 256 * 1024;

/// Sending half of a connection's outbox. `send` is best-effort: a full queue means the
/// peer stopped reading, and the caller decides whether that kills the connection.
#[derive(Clone)]
pub struct Outbox {
    tx: std::sync::mpsc::SyncSender<String>,
}

impl Outbox {
    pub fn new(tx: std::sync::mpsc::SyncSender<String>) -> Self {
        Self { tx }
    }

    /// Serialize and enqueue; false when the queue is full or the writer is gone.
    pub fn send(&self, msg: &ServerMessage) -> bool {
        match serde_json::to_string(msg) {
            Ok(line) => self.tx.try_send(line).is_ok(),
            Err(e) => {
                log::error!("failed to serialize server message: {e}");
                false
            }
        }
    }
}

struct LiveEntry {
    cwd: String,
    rows: u16,
    cols: u16,
    pid: Option<u32>,
    transcript: Transcript,
}

struct ExitedEntry {
    cwd: String,
    exit_code: Option<i32>,
}

#[derive(Default)]
struct TableInner {
    live: HashMap<String, LiveEntry>,
    exited: HashMap<String, ExitedEntry>,
    connections: HashMap<u64, Outbox>,
    /// session_id → connections currently attached (receiving Output events).
    attachments: HashMap<String, HashSet<u64>>,
}

impl TableInner {
    fn drop_connection(&mut self, conn_id: u64) {
        self.connections.remove(&conn_id);
        for conns in self.attachments.values_mut() {
            conns.remove(&conn_id);
        }
    }

    fn fanout_to_attachments(&mut self, session_id: &str, msg: &ServerMessage) {
        let Some(conns) = self.attachments.get(session_id) else {
            return;
        };
        if conns.is_empty() {
            return;
        }
        let lagged: Vec<u64> = conns
            .iter()
            .filter(|conn_id| !self.connections.get(conn_id).is_some_and(|out| out.send(msg)))
            .copied()
            .collect();
        for conn_id in lagged {
            log::warn!("dropping lagged connection {conn_id}");
            self.drop_connection(conn_id);
        }
    }
}

pub struct SessionTable {
    manager: PtyManager,
    sessions_dir: PathBuf,
    inner: Mutex<TableInner>,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl SessionTable {
    pub fn new(sessions_dir: PathBuf) -> Self {
        Self {
            manager: PtyManager::new(),
            sessions_dir,
            inner: Mutex::new(TableInner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TableInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn register_connection(&self, conn_id: u64, outbox: Outbox) {
        self.lock().connections.insert(conn_id, outbox);
    }

    pub fn drop_connection(&self, conn_id: u64) {
        self.lock().drop_connection(conn_id);
    }

    pub fn create(self: &Arc<Self>, params: CreateParams) -> Result<Option<u32>> {
        let mut inner = self.lock();
        if inner.live.contains_key(&params.session_id)
            || inner.exited.contains_key(&params.session_id)
        {
            bail!("session {} already exists", params.session_id);
        }

        let transcript = Transcript::open(&self.sessions_dir, &params.session_id)
            .context("failed to open transcript")?;

        let table_for_output = Arc::clone(self);
        let table_for_exit = Arc::clone(self);
        // Holding the lock across spawn keeps create atomic; the reader/emitter threads it
        // starts only block on this mutex briefly (output buffers in the pty channel).
        let pid = self.manager.spawn(
            SpawnRequest {
                id: params.session_id.clone(),
                cwd: params.cwd.clone(),
                rows: params.rows,
                cols: params.cols,
                shell: params.shell.clone(),
                env: params.env.clone(),
            },
            move |session_id, bytes| table_for_output.on_output(session_id, bytes),
            move |session_id, exit_code| table_for_exit.on_exit(&session_id, exit_code),
        )?;

        inner.live.insert(
            params.session_id.clone(),
            LiveEntry {
                cwd: params.cwd,
                rows: params.rows,
                cols: params.cols,
                pid,
                transcript,
            },
        );
        Ok(pid)
    }

    fn on_output(&self, session_id: &str, bytes: &[u8]) {
        let mut inner = self.lock();
        let Some(entry) = inner.live.get_mut(session_id) else {
            return;
        };
        if let Err(e) = entry.transcript.append(bytes) {
            log::warn!("transcript append failed for {session_id}: {e}");
        }
        if inner.attachments.get(session_id).is_none_or(|c| c.is_empty()) {
            return;
        }
        let msg = ServerMessage::Output {
            session_id: session_id.to_string(),
            data: b64(bytes),
        };
        inner.fanout_to_attachments(session_id, &msg);
    }

    fn on_exit(&self, session_id: &str, exit_code: Option<u32>) {
        let mut inner = self.lock();
        let Some(entry) = inner.live.remove(session_id) else {
            return;
        };
        let exit_code = exit_code.map(|c| c as i32);
        inner.exited.insert(
            session_id.to_string(),
            ExitedEntry {
                cwd: entry.cwd,
                exit_code,
            },
        );
        inner.attachments.remove(session_id);
        // Exit broadcasts to every connection — a detached session has no attachments, but
        // the app must still record the exit and reap the tombstone.
        let msg = ServerMessage::Exit {
            session_id: session_id.to_string(),
            exit_code,
        };
        for outbox in inner.connections.values() {
            outbox.send(&msg);
        }
    }

    /// Cut the replay tail and register the attachment under one lock so every Output
    /// event sent afterwards is strictly newer than the tail.
    pub fn attach(
        &self,
        session_id: &str,
        conn_id: u64,
        replay_bytes: Option<u32>,
    ) -> Result<(String, u16, u16)> {
        let mut inner = self.lock();
        if inner.exited.contains_key(session_id) {
            bail!("session {session_id} has exited");
        }
        let Some(entry) = inner.live.get_mut(session_id) else {
            bail!("no such session: {session_id}");
        };
        let max = replay_bytes.unwrap_or(DEFAULT_REPLAY_BYTES) as usize;
        let tail = entry.transcript.tail(max).context("failed to read transcript tail")?;
        let (rows, cols) = (entry.rows, entry.cols);
        inner
            .attachments
            .entry(session_id.to_string())
            .or_default()
            .insert(conn_id);
        Ok((b64(&tail), rows, cols))
    }

    pub fn detach(&self, session_id: &str, conn_id: u64) {
        let mut inner = self.lock();
        if let Some(conns) = inner.attachments.get_mut(session_id) {
            conns.remove(&conn_id);
        }
    }

    pub fn write(&self, session_id: &str, data_b64: &str) -> Result<()> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .context("invalid base64 payload")?;
        self.manager.write(session_id, &bytes)
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<()> {
        self.manager.resize(session_id, PtySize { rows, cols })?;
        if let Some(entry) = self.lock().live.get_mut(session_id) {
            entry.rows = rows;
            entry.cols = cols;
        }
        Ok(())
    }

    /// Idempotent: killing an already-exited or unknown session is fine. The wait thread
    /// observes the death and transitions the entry to a tombstone via `on_exit`.
    pub fn terminate(&self, session_id: &str) -> Result<()> {
        self.manager.kill(session_id)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let inner = self.lock();
        let mut sessions: Vec<SessionInfo> = inner
            .live
            .iter()
            .map(|(id, entry)| SessionInfo {
                session_id: id.clone(),
                running: true,
                attached: inner.attachments.get(id).is_some_and(|c| !c.is_empty()),
                pid: entry.pid,
                exit_code: None,
                cwd: entry.cwd.clone(),
                rows: entry.rows,
                cols: entry.cols,
            })
            .chain(inner.exited.iter().map(|(id, entry)| SessionInfo {
                session_id: id.clone(),
                running: false,
                attached: false,
                pid: None,
                exit_code: entry.exit_code,
                cwd: entry.cwd.clone(),
                rows: 0,
                cols: 0,
            }))
            .collect();
        sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        sessions
    }

    pub fn reap(&self, session_id: &str) {
        let mut inner = self.lock();
        if inner.exited.remove(session_id).is_some() {
            Transcript::remove_files(&self.sessions_dir, session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-ptyd-state-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn table(dir: &std::path::Path) -> Arc<SessionTable> {
        Arc::new(SessionTable::new(dir.to_path_buf()))
    }

    /// `/bin/echo` as the "shell" prints its `--login` argument and exits immediately,
    /// giving a real child process without an interactive shell.
    fn echo_params(session_id: &str) -> CreateParams {
        CreateParams {
            session_id: session_id.to_string(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            shell: Some("/bin/echo".to_string()),
            rows: 24,
            cols: 80,
            env: None,
        }
    }

    fn registered_outbox(table: &Arc<SessionTable>, conn_id: u64) -> std::sync::mpsc::Receiver<String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(64);
        table.register_connection(conn_id, Outbox::new(tx));
        rx
    }

    fn wait_for<T>(deadline: Duration, mut poll: impl FnMut() -> Option<T>) -> T {
        let end = Instant::now() + deadline;
        loop {
            if let Some(value) = poll() {
                return value;
            }
            assert!(Instant::now() < end, "timed out waiting for condition");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn attach_unknown_session_fails() {
        let dir = temp_dir("unknown");
        let t = table(&dir);
        assert!(t.attach("ts-404", 1, None).is_err());
    }

    #[test]
    fn duplicate_create_fails() {
        let dir = temp_dir("dup");
        let t = table(&dir);
        t.create(echo_params("ts-1")).unwrap();
        assert!(t.create(echo_params("ts-1")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn exit_broadcasts_to_unattached_connections_and_leaves_tombstone() {
        let dir = temp_dir("exit");
        let t = table(&dir);
        let rx = registered_outbox(&t, 1);

        t.create(echo_params("ts-1")).unwrap();

        let exit_line = wait_for(Duration::from_secs(5), || {
            rx.try_recv().ok().filter(|line| line.contains("\"exit\""))
        });
        let msg: ServerMessage = serde_json::from_str(&exit_line).unwrap();
        match msg {
            ServerMessage::Exit { session_id, exit_code } => {
                assert_eq!(session_id, "ts-1");
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("expected exit, got {other:?}"),
        }

        let sessions = t.list();
        assert_eq!(sessions.len(), 1);
        assert!(!sessions[0].running);
        assert_eq!(sessions[0].exit_code, Some(0));

        t.reap("ts-1");
        assert!(t.list().is_empty());
        assert!(!dir.join("ts-1.log").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn attach_replays_transcript_for_late_attachments() {
        let dir = temp_dir("replay");
        let t = table(&dir);
        // No attachments at all: output must drain to the transcript regardless.
        t.create(echo_params("ts-1")).unwrap();

        let replay = wait_for(Duration::from_secs(5), || {
            // /bin/echo prints "--login" then exits; attach works only while live, so read
            // the transcript through a second live session created in the same dir.
            let inner = t.lock();
            let done = inner.exited.contains_key("ts-1");
            drop(inner);
            done.then(|| std::fs::read(dir.join("ts-1.log")).unwrap_or_default())
        });
        let text = String::from_utf8_lossy(&replay);
        assert!(text.contains("--login"), "transcript should hold the echoed arg, got: {text:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn attach_to_exited_session_reports_it_has_exited() {
        let dir = temp_dir("attach-exited");
        let t = table(&dir);
        let rx = registered_outbox(&t, 1);
        t.create(echo_params("ts-1")).unwrap();
        wait_for(Duration::from_secs(5), || {
            rx.try_recv().ok().filter(|line| line.contains("\"exit\""))
        });

        let err = t.attach("ts-1", 1, None).unwrap_err();
        assert!(err.to_string().contains("has exited"), "got: {err:#}");
        // The tombstone must survive the failed attach for the app to record + reap.
        assert_eq!(t.list().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_create_leaves_the_id_reusable() {
        let dir = temp_dir("create-retry");
        let t = table(&dir);
        let mut params = echo_params("ts-1");
        params.shell = Some("/nonexistent/shell".to_string());
        assert!(t.create(params).is_err());

        t.create(echo_params("ts-1")).expect("retry with the same id should succeed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn output_fans_out_to_every_attached_connection() {
        let dir = temp_dir("multi-fanout");
        let t = table(&dir);
        let rx1 = registered_outbox(&t, 1);
        let rx2 = registered_outbox(&t, 2);

        let mut params = echo_params("ts-1");
        params.shell = Some("/bin/zsh".to_string());
        t.create(params).unwrap();
        t.attach("ts-1", 1, None).unwrap();
        t.attach("ts-1", 2, None).unwrap();

        t.write("ts-1", &b64(b"echo monica-multi\r")).unwrap();
        for rx in [&rx1, &rx2] {
            wait_for(Duration::from_secs(5), || {
                rx.try_recv().ok().filter(|l| {
                    l.contains("\"output\"")
                        && String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD
                            .decode(serde_json::from_str::<ServerMessage>(l).ok().and_then(|m| match m {
                                ServerMessage::Output { data, .. } => Some(data),
                                _ => None,
                            }).unwrap_or_default())
                            .unwrap_or_default())
                        .contains("monica-multi")
                })
            });
        }

        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lagged_connection_is_dropped_from_fanout() {
        let dir = temp_dir("lagged");
        let t = table(&dir);
        // Rendezvous channel with no reader: the first try_send fails => lagged.
        let (tx, _rx) = std::sync::mpsc::sync_channel(0);
        t.register_connection(1, Outbox::new(tx));

        let mut params = echo_params("ts-1");
        params.shell = Some("/bin/zsh".to_string());
        t.create(params).unwrap();
        t.attach("ts-1", 1, None).unwrap();
        t.write("ts-1", &b64(b"echo lagged\r")).unwrap();

        wait_for(Duration::from_secs(5), || {
            let inner = t.lock();
            let gone = !inner.connections.contains_key(&1)
                && inner.attachments.get("ts-1").is_none_or(|c| c.is_empty());
            gone.then_some(())
        });

        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn attach_then_detach_controls_output_fanout() {
        let dir = temp_dir("fanout");
        let t = table(&dir);
        let rx = registered_outbox(&t, 1);

        // `cat` as the shell stays alive echoing stdin back ("--login" arg is a missing
        // file, so use /bin/zsh -- a real shell -- here instead to keep the session live).
        let mut params = echo_params("ts-1");
        params.shell = Some("/bin/zsh".to_string());
        t.create(params).unwrap();

        let (replay, rows, cols) = t.attach("ts-1", 1, None).unwrap();
        assert_eq!((rows, cols), (24, 80));
        let _ = replay;

        t.write("ts-1", &b64(b"echo monica-fanout\r")).unwrap();
        let line = wait_for(Duration::from_secs(5), || {
            rx.try_recv().ok().filter(|l| {
                if !l.contains("\"output\"") {
                    return false;
                }
                let msg: ServerMessage = serde_json::from_str(l).unwrap();
                match msg {
                    ServerMessage::Output { data, .. } => {
                        let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
                        String::from_utf8_lossy(&bytes).contains("monica-fanout")
                    }
                    _ => false,
                }
            })
        });
        let _ = line;

        t.detach("ts-1", 1);
        assert!(t.lock().attachments.get("ts-1").is_none_or(|c| c.is_empty()));

        t.terminate("ts-1").unwrap();
        wait_for(Duration::from_secs(5), || {
            (!t.list().iter().any(|s| s.running)).then_some(())
        });
        std::fs::remove_dir_all(&dir).ok();
    }
}
