//! Session/connection bookkeeping for the daemon. One mutex guards everything: transcript
//! appends, attach (tail cut + fanout registration), catch-up, and exit transitions all
//! serialize through it, which is what makes replay-then-stream and catch-up-then-stream
//! gapless and duplicate-free without sequence numbers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use base64::Engine;

use super::outbox::Outbox;
use crate::manager::PtyManager;
use crate::terminal_modes::TerminalModes;
use crate::transcript::{self, Transcript};
use crate::types::{PtySize, SpawnRequest};
use tania_terminal_protocol::{CreateParams, ServerMessage, SessionInfo};

const DEFAULT_REPLAY_BYTES: u32 = 256 * 1024;
/// Larger than a PTY read, so a backlog drains in fewer frames.
const CATCH_UP_CHUNK: usize = 16 * 1024;

/// How an attached connection receives a session's output.
enum Feed {
    Live,
    /// The connection's queue filled up, so the output from `resume_at` on waits in the
    /// transcript until catch-up sends it.
    Behind {
        resume_at: u64,
        since: Instant,
        /// Fed what catch-up sends, so a restore after lost output knows which buffer the
        /// connection's terminal is in.
        sent: TerminalModes,
    },
}

struct LiveEntry {
    cwd: String,
    rows: u16,
    cols: u16,
    pid: Option<u32>,
    transcript: Transcript,
    modes: TerminalModes,
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
    /// session_id → connections currently attached, and how each receives the output.
    attachments: HashMap<String, HashMap<u64, Feed>>,
}

impl TableInner {
    fn drop_connection(&mut self, conn_id: u64) {
        self.connections.remove(&conn_id);
        for conns in self.attachments.values_mut() {
            conns.remove(&conn_id);
        }
    }

    fn fanout_to_attachments(&mut self, session_id: &str, msg: &ServerMessage, chunk_start: u64) {
        let (Some(conns), Some(entry)) = (
            self.attachments.get_mut(session_id),
            self.live.get_mut(session_id),
        ) else {
            return;
        };
        for (conn_id, feed) in conns.iter_mut() {
            if !matches!(feed, Feed::Live) {
                continue;
            }
            let Some(out) = self.connections.get(conn_id) else {
                continue;
            };
            if out.send_live(msg) {
                continue;
            }
            log::info!("connection {conn_id} fell behind on {session_id}");
            *feed = Feed::Behind {
                resume_at: chunk_start,
                since: Instant::now(),
                sent: entry
                    .modes
                    .for_client_behind_by(entry.transcript.end() - chunk_start),
            };
            out.set_behind(true);
            if out.drained() {
                while queue_missed_chunk(out, entry, *conn_id, session_id, feed) {}
            }
        }
    }
}

/// Queues the next chunk a behind attachment missed, below the catch-up ceiling, or turns it
/// live once nothing more is missing or can be had from the transcript. False when it queued
/// nothing.
fn queue_missed_chunk(
    out: &Outbox,
    entry: &mut LiveEntry,
    conn_id: u64,
    session_id: &str,
    feed: &mut Feed,
) -> bool {
    let Feed::Behind {
        resume_at,
        since,
        sent,
    } = feed
    else {
        return false;
    };
    if !out.has_room_to_catch_up() {
        return false;
    }
    let missed = match entry.read_missed(*resume_at, sent) {
        Ok(missed) => missed,
        Err(e) => {
            log::warn!(
                "connection {conn_id} lost the output of {session_id} from {resume_at}: {e:#}"
            );
            *feed = Feed::Live;
            return false;
        }
    };
    let lost = missed.start - *resume_at;
    if missed.output.is_empty() && lost == 0 {
        log::info!(
            "connection {conn_id} caught up on {session_id} after {}ms",
            since.elapsed().as_millis()
        );
        *feed = Feed::Live;
        return false;
    }
    let next = missed.start + missed.output.len() as u64;
    let data = [missed.restore, missed.output].concat();
    let msg = ServerMessage::Output {
        session_id: session_id.to_string(),
        data: b64(&data),
    };
    if !out.send(&msg) {
        return false;
    }
    sent.feed(&data);
    if lost > 0 {
        log::warn!(
            "connection {conn_id} lost {lost} bytes of {session_id} that rotated out of the transcript, and got its terminal modes again"
        );
    }
    *resume_at = next;
    true
}

/// The next chunk of output a behind attachment has not been sent.
struct Missed {
    /// Later than where the attachment resumes when rotation already dropped the output there.
    start: u64,
    /// Empty unless output was dropped, since only that may have switched modes the
    /// connection's terminal is still in.
    restore: Vec<u8>,
    output: Vec<u8>,
}

impl LiveEntry {
    /// `sent` is what the attachment has been sent since it fell behind.
    fn read_missed(&mut self, resume_at: u64, sent: &TerminalModes) -> Result<Missed> {
        let (start, output) = self.transcript.read_from(resume_at, CATCH_UP_CHUNK)?;
        let restore = if start == resume_at {
            Vec::new()
        } else {
            // The restore leaves to the rest of the output the modes it switches itself, so it
            // has to see all of it, not just this chunk.
            let (_, rest) = self.transcript.read_from(start, usize::MAX)?;
            self.modes.restore_prefix_after_gap(sent, &rest)
        };
        Ok(Missed {
            start,
            restore,
            output,
        })
    }
}

pub struct SessionTable {
    manager: PtyManager,
    sessions_dir: PathBuf,
    transcript_rotate_bytes: u64,
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
            transcript_rotate_bytes: transcript::ROTATE_BYTES,
            inner: Mutex::new(TableInner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TableInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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

        let transcript = Transcript::open(
            &self.sessions_dir,
            &params.session_id,
            self.transcript_rotate_bytes,
        )
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
                modes: TerminalModes::default(),
            },
        );
        Ok(pid)
    }

    fn on_output(&self, session_id: &str, bytes: &[u8]) {
        let mut inner = self.lock();
        let Some(entry) = inner.live.get_mut(session_id) else {
            return;
        };
        let start = entry.transcript.end();
        if let Err(e) = entry.transcript.append(bytes) {
            log::warn!("transcript append failed for {session_id}: {e}");
        }
        entry.modes.feed(bytes);
        if inner
            .attachments
            .get(session_id)
            .is_none_or(|c| c.is_empty())
        {
            return;
        }
        let msg = ServerMessage::Output {
            session_id: session_id.to_string(),
            data: b64(bytes),
        };
        inner.fanout_to_attachments(session_id, &msg, start);
    }

    /// Holding the lock keeps `on_output` out, so what an attachment catches up on and the live
    /// output after it meet without a gap or an overlap.
    pub fn catch_up(&self, conn_id: u64) {
        let mut guard = self.lock();
        let TableInner {
            live,
            connections,
            attachments,
            ..
        } = &mut *guard;
        let Some(out) = connections.get(&conn_id) else {
            return;
        };
        let is_behind =
            |conns: &HashMap<u64, Feed>| matches!(conns.get(&conn_id), Some(Feed::Behind { .. }));
        let mut turns: Vec<String> = attachments
            .iter()
            .filter(|(_, conns)| is_behind(conns))
            .map(|(session_id, _)| session_id.clone())
            .collect();
        // A chunk per turn, so a session that keeps printing cannot take all the room.
        while !turns.is_empty() {
            turns.retain(|session_id| {
                let feed = attachments
                    .get_mut(session_id)
                    .and_then(|conns| conns.get_mut(&conn_id));
                // Exit drops a session's attachments, so an attached session is always live.
                let (Some(feed), Some(entry)) = (feed, live.get_mut(session_id)) else {
                    return false;
                };
                queue_missed_chunk(out, entry, conn_id, session_id, feed)
            });
        }
        out.set_behind(attachments.values().any(is_behind));
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
        for (conn_id, feed) in inner.attachments.remove(session_id).unwrap_or_default() {
            if let Feed::Behind { resume_at, .. } = feed {
                log::warn!(
                    "connection {conn_id} never got the last {} bytes of {session_id}, which exited while it was behind",
                    entry.transcript.end() - resume_at
                );
            }
        }
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
        let tail = entry
            .transcript
            .tail(max)
            .context("failed to read transcript tail")?;
        // The tail is a suffix of the output, so mode transitions older than it are lost.
        // Leading with the ones it cannot convey keeps the client's modes honest -- notably the
        // alt screen, which apps enter exactly once at startup.
        let mut replay = entry.modes.restore_prefix(&tail);
        replay.extend_from_slice(&tail);
        let (rows, cols) = (entry.rows, entry.cols);
        inner
            .attachments
            .entry(session_id.to_string())
            .or_default()
            .insert(conn_id, Feed::Live);
        Ok((b64(&replay), rows, cols))
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
    use std::io::BufReader;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use tania_terminal_protocol::{read_frames, write_frame, Request, RequestOp, ResponseBody};

    use crate::daemon::connection::serve_connection;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tania-ptyd-state-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn table(dir: &std::path::Path) -> Arc<SessionTable> {
        Arc::new(SessionTable::new(dir.to_path_buf()))
    }

    /// Keeps 64–128 KB, so an 800 KB burst outruns it.
    fn small_transcript_table(dir: &Path) -> Arc<SessionTable> {
        Arc::new(SessionTable {
            transcript_rotate_bytes: 64 * 1024,
            ..SessionTable::new(dir.to_path_buf())
        })
    }

    /// Claude Code's startup, trimmed to one mode of each kind ptyd tracks.
    const TUI_START: &[u8] = b"\x1b[?1049h\x1b[>1u\x1b[?1003h\x1b[?1006h\x1b[?2004h";

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

    fn registered_outbox(
        table: &Arc<SessionTable>,
        conn_id: u64,
    ) -> std::sync::mpsc::Receiver<String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(64);
        table.register_connection(conn_id, Outbox::unmetered(tx));
        rx
    }

    /// A shell that prints nothing, so everything the session outputs comes from the test.
    fn quiet_params(dir: &Path, session_id: &str) -> CreateParams {
        std::fs::create_dir_all(dir).unwrap();
        let script = dir.join("quiet.sh");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 600\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        CreateParams {
            shell: Some(script.to_string_lossy().to_string()),
            ..echo_params(session_id)
        }
    }

    /// Prints `chunks` distinct 1 KB chunks, the size macOS hands out per PTY read, and returns
    /// them concatenated.
    fn burst(t: &SessionTable, session_id: &str, chunks: usize) -> Vec<u8> {
        let mut printed = Vec::new();
        for i in 0..chunks {
            let chunk = format!("{session_id}:{i:06} ").repeat(128)[..1024].to_string();
            t.on_output(session_id, chunk.as_bytes());
            printed.extend_from_slice(chunk.as_bytes());
        }
        printed
    }

    fn assert_same_bytes(got: &[u8], want: &[u8]) {
        let first_diff = got.iter().zip(want).position(|(a, b)| a != b);
        assert!(
            got == want,
            "got {} bytes, want {}; first difference at {first_diff:?}",
            got.len(),
            want.len()
        );
    }

    /// Checks that `got` is the start of `printed`, then `restore`, then the end of `printed`,
    /// with output lost in between.
    fn assert_restored_after_loss(got: &[u8], printed: &[u8], restore: &str) {
        let Some(at) = got
            .windows(restore.len())
            .position(|w| w == restore.as_bytes())
        else {
            let diverged = got.iter().zip(printed).take_while(|(a, b)| a == b).count();
            let around = &got[diverged.saturating_sub(16)..got.len().min(diverged + 96)];
            panic!(
                "no restore where the output diverged: {:?}",
                String::from_utf8_lossy(around)
            );
        };
        let (before, after) = (&got[..at], &got[at + restore.len()..]);
        assert!(
            printed.starts_with(before),
            "the output before the loss must arrive in order"
        );
        assert!(
            printed.ends_with(after),
            "the output the transcript kept must arrive in order"
        );
        assert!(
            before.len() + after.len() < printed.len(),
            "the burst must outrun the transcript"
        );
    }

    fn decode(data: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap()
    }

    /// The app's end of a ptyd connection, served by the real connection loop. Nothing is read
    /// off the socket until the test asks, which is how it stands in for a stalled Shell.
    struct Peer {
        stream: UnixStream,
        frames: Box<dyn Iterator<Item = ServerMessage>>,
        output: HashMap<String, Vec<u8>>,
    }

    impl Peer {
        fn connect(t: &Arc<SessionTable>, conn_id: u64) -> Self {
            let (client, server) = UnixStream::pair().unwrap();
            let table = Arc::clone(t);
            std::thread::spawn(move || serve_connection(server, table, conn_id));
            client
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let reader = BufReader::new(client.try_clone().unwrap());
            Self {
                stream: client,
                frames: Box::new(read_frames(reader).map(Result::unwrap)),
                output: HashMap::new(),
            }
        }

        fn send(&mut self, id: u64, op: RequestOp) {
            write_frame(&mut self.stream, &Request { id: Some(id), op }).unwrap();
        }

        fn next(&mut self) -> ServerMessage {
            let msg = self
                .frames
                .next()
                .expect("the connection closed or went quiet");
            if let ServerMessage::Output { session_id, data } = &msg {
                self.output
                    .entry(session_id.clone())
                    .or_default()
                    .extend(decode(data));
            }
            msg
        }

        fn response(&mut self, id: u64) -> ResponseBody {
            loop {
                match self.next() {
                    ServerMessage::Ok { id: got, body } if got == id => return body,
                    ServerMessage::Err { id: got, error } if got == id => panic!("{error}"),
                    _ => {}
                }
            }
        }

        fn attach(&mut self, id: u64, session_id: &str) {
            self.send(
                id,
                RequestOp::Attach {
                    session_id: session_id.to_string(),
                    replay_bytes: None,
                },
            );
            self.response(id);
        }

        /// Everything `session_id` has sent so far, once it reaches `len` bytes.
        fn output_of(&mut self, session_id: &str, len: usize) -> Vec<u8> {
            self.output_once(session_id, |got| got.len() >= len)
        }

        /// Everything `session_id` has sent so far, once it ends with `last`.
        fn output_ending_with(&mut self, session_id: &str, last: &[u8]) -> Vec<u8> {
            self.output_once(session_id, |got| got.ends_with(last))
        }

        fn output_once(&mut self, session_id: &str, done: impl Fn(&[u8]) -> bool) -> Vec<u8> {
            while !done(self.output.get(session_id).map_or(&[], Vec::as_slice)) {
                self.next();
            }
            self.output[session_id].clone()
        }
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
            ServerMessage::Exit {
                session_id,
                exit_code,
            } => {
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
    fn output_of_a_never_attached_session_reaches_the_transcript() {
        let dir = temp_dir("replay");
        let t = table(&dir);
        // No attachments at all: output must drain to the transcript regardless.
        t.create(echo_params("ts-1")).unwrap();

        let replay = wait_for(Duration::from_secs(5), || {
            // /bin/echo prints "--login" then exits, and attach works only while live, so
            // read the transcript file itself.
            let inner = t.lock();
            let done = inner.exited.contains_key("ts-1");
            drop(inner);
            done.then(|| std::fs::read(dir.join("ts-1.log")).unwrap_or_default())
        });
        let text = String::from_utf8_lossy(&replay);
        assert!(
            text.contains("--login"),
            "transcript should hold the echoed arg, got: {text:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The alt screen is entered once at startup, so a long session's transcript tail no
    /// longer carries it and only the tracked state can tell the client where it is.
    #[test]
    fn attach_restores_tracked_modes_ahead_of_the_replay_tail() {
        let dir = temp_dir("mode-restore");
        let t = table(&dir);
        let mut params = echo_params("ts-1");
        params.shell = Some("/bin/zsh".to_string());
        t.create(params).unwrap();

        t.on_output("ts-1", b"\x1b[?1049h\x1b[?1002h\x1b[?1006h");
        t.on_output("ts-1", &b"painted".repeat(64));

        // A window this small cannot reach back to the handshake, so only the prefix can carry
        // it -- which is the situation a pane reconnected after an app restart is in.
        let (replay, _, _) = t.attach("ts-1", 1, Some(32)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(replay)
            .unwrap();

        // The invariant that matters: a client consuming this replay lands on the tracked
        // state, so it has nothing left to assert of its own.
        let mut client = TerminalModes::default();
        client.feed(&bytes);
        let client_state = client.restore_prefix(b"");
        assert_eq!(
            client_state,
            t.lock().live["ts-1"].modes.restore_prefix(b"")
        );
        assert!(
            client_state.starts_with(b"\x1b[?1049h"),
            "the alt screen must survive a replay window that excludes it, got: {:?}",
            String::from_utf8_lossy(&client_state)
        );
        assert!(
            bytes.ends_with(b"painted"),
            "the size-capped tail must still follow the prefix, got: {:?}",
            String::from_utf8_lossy(&bytes)
        );

        t.terminate("ts-1").unwrap();
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

        t.create(echo_params("ts-1"))
            .expect("retry with the same id should succeed");
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
                        && String::from_utf8_lossy(
                            &base64::engine::general_purpose::STANDARD
                                .decode(
                                    serde_json::from_str::<ServerMessage>(l)
                                        .ok()
                                        .and_then(|m| match m {
                                            ServerMessage::Output { data, .. } => Some(data),
                                            _ => None,
                                        })
                                        .unwrap_or_default(),
                                )
                                .unwrap_or_default(),
                        )
                        .contains("monica-multi")
                })
            });
        }

        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 800 frames are far more than the queue and the socket buffers hold together.
    #[test]
    fn a_connection_that_stops_reading_catches_up_from_the_transcript() {
        let dir = temp_dir("catch-up");
        let t = table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");

        let printed = burst(&t, "ts-1", 800);

        assert_same_bytes(&peer.output_of("ts-1", printed.len()), &printed);
        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn terminal_sessions_on_one_connection_each_catch_up_on_their_own_output() {
        let dir = temp_dir("catch-up-many");
        let t = table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        t.create(quiet_params(&dir, "ts-2")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        peer.attach(2, "ts-2");

        let mut printed_1 = burst(&t, "ts-1", 500);
        let printed_2 = burst(&t, "ts-2", 300);
        printed_1.extend(burst(&t, "ts-1", 100));

        assert_same_bytes(&peer.output_of("ts-1", printed_1.len()), &printed_1);
        assert_same_bytes(&peer.output_of("ts-2", printed_2.len()), &printed_2);
        t.terminate("ts-1").unwrap();
        t.terminate("ts-2").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn terminal_sessions_behind_on_one_connection_take_turns_catching_up() {
        let dir = temp_dir("catch-up-turns");
        let t = table(&dir);
        for id in ["ts-0", "ts-1", "ts-2"] {
            t.create(quiet_params(&dir, id)).unwrap();
        }
        let mut peer = Peer::connect(&t, 1);
        for (id, session_id) in [(1, "ts-0"), (2, "ts-1"), (3, "ts-2")] {
            peer.attach(id, session_id);
        }
        // ts-0 fills the queue, so ts-1 and ts-2 get nothing live and all of theirs is catch-up.
        burst(&t, "ts-0", 300);
        let printed_1 = burst(&t, "ts-1", 800);
        let printed_2 = burst(&t, "ts-2", 800);

        loop {
            peer.next();
            let got_1 = peer.output.get("ts-1").map_or(0, Vec::len);
            let got_2 = peer.output.get("ts-2").map_or(0, Vec::len);
            if got_1 == printed_1.len() || got_2 == printed_2.len() {
                assert!(
                    got_1 > 0 && got_2 > 0,
                    "one caught up fully before the other got anything: {got_1} and {got_2} bytes"
                );
                break;
            }
        }
        assert_same_bytes(&peer.output_of("ts-1", printed_1.len()), &printed_1);
        assert_same_bytes(&peer.output_of("ts-2", printed_2.len()), &printed_2);
        for id in ["ts-0", "ts-1", "ts-2"] {
            t.terminate(id).unwrap();
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_terminal_session_stays_live_while_another_on_its_connection_is_behind() {
        let dir = temp_dir("live-beside-behind");
        let t = table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        t.create(quiet_params(&dir, "ts-2")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        peer.attach(2, "ts-2");
        let printed_1 = burst(&t, "ts-1", 800);
        // Makes room for live output while leaving far more queued than catch-up waits for.
        for _ in 0..100 {
            peer.next();
        }

        let printed_2 = burst(&t, "ts-2", 3);

        assert_same_bytes(&peer.output_of("ts-2", printed_2.len()), &printed_2);
        assert!(
            peer.output["ts-1"].len() < printed_1.len(),
            "ts-2 must not wait for ts-1 to catch up"
        );
        assert_same_bytes(&peer.output_of("ts-1", printed_1.len()), &printed_1);
        t.terminate("ts-1").unwrap();
        t.terminate("ts-2").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The restore would only state the modes the connection's terminal is already in.
    #[test]
    fn a_catch_up_that_lost_nothing_sends_no_restore() {
        let dir = temp_dir("caught-up-in-alt");
        let t = table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        t.on_output("ts-1", TUI_START);

        let printed = [TUI_START, &burst(&t, "ts-1", 800)].concat();

        assert_same_bytes(&peer.output_of("ts-1", printed.len()), &printed);
        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Leaving and re-entering, rather than entering again, is what lands the connection where
    /// an attach would: xterm swaps the kitty flags on every `?1049h`, even one it is already in.
    #[test]
    fn a_connection_that_lost_output_reenters_the_alt_screen_before_the_rest() {
        let dir = temp_dir("lost-in-alt");
        let t = small_transcript_table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        t.on_output("ts-1", TUI_START);
        peer.output_of("ts-1", TUI_START.len());

        let printed = [TUI_START, &burst(&t, "ts-1", 800)].concat();

        let got = peer.output_ending_with("ts-1", &printed[printed.len() - 1024..]);
        assert_restored_after_loss(
            &got,
            &printed,
            "\x1b[<32u\x1b[?1049l\x1b[<32u\
             \x1b[?1049h\x1b[?2004h\x1b[?1004l\x1b[?25h\x1b[?1003h\x1b[?1006h\x1b[>1u",
        );
        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_connection_that_lost_a_tui_exiting_leaves_the_alt_screen_before_the_rest() {
        let dir = temp_dir("lost-exit");
        let t = small_transcript_table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        t.on_output("ts-1", TUI_START);
        peer.output_of("ts-1", TUI_START.len());
        let tui_exit = b"\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[<u\x1b[?1049l";

        let mut printed = [TUI_START, &burst(&t, "ts-1", 400)].concat();
        t.on_output("ts-1", tui_exit);
        printed.extend(tui_exit);
        printed.extend(burst(&t, "ts-1", 400));

        let got = peer.output_ending_with("ts-1", &printed[printed.len() - 1024..]);
        assert_restored_after_loss(
            &got,
            &printed,
            "\x1b[<32u\x1b[?1049l\x1b[<32u\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1000l\x1b[?1006l",
        );
        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// More switches than ptyd keeps a history of, so only what the connection was sent can
    /// tell which buffer it was left in.
    #[test]
    fn a_connection_left_in_the_alt_screen_leaves_it_however_often_the_lost_output_switched() {
        let dir = temp_dir("lost-switches");
        let t = small_transcript_table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        t.on_output("ts-1", TUI_START);
        peer.output_of("ts-1", TUI_START.len());
        let switches = [&b"\x1b[?1049l"[..], &b"\x1b[?1049h\x1b[?1049l".repeat(300)].concat();

        let mut printed = [TUI_START, &burst(&t, "ts-1", 400)].concat();
        t.on_output("ts-1", &switches);
        printed.extend(&switches);
        printed.extend(burst(&t, "ts-1", 400));

        let got = peer.output_ending_with("ts-1", &printed[printed.len() - 1024..]);
        assert_restored_after_loss(
            &got,
            &printed,
            "\x1b[<32u\x1b[?1049l\x1b[<32u\
             \x1b[?2004h\x1b[?1004l\x1b[?25h\x1b[?1003h\x1b[?1006h\x1b[>1u",
        );
        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_connection_that_is_behind_still_gets_responses() {
        let dir = temp_dir("behind-responses");
        let t = table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        burst(&t, "ts-1", 800);

        peer.send(2, RequestOp::List);

        let ResponseBody::Sessions { sessions } = peer.response(2) else {
            panic!("list should answer with the sessions");
        };
        assert!(sessions[0].attached, "the connection must stay attached");
        t.terminate("ts-1").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reattaching_while_behind_starts_over_from_the_replay() {
        let dir = temp_dir("behind-reattach");
        let t = table(&dir);
        t.create(quiet_params(&dir, "ts-1")).unwrap();
        let mut peer = Peer::connect(&t, 1);
        peer.attach(1, "ts-1");
        let printed = burst(&t, "ts-1", 800);

        peer.send(
            2,
            RequestOp::Detach {
                session_id: "ts-1".to_string(),
            },
        );
        peer.send(
            3,
            RequestOp::Attach {
                session_id: "ts-1".to_string(),
                replay_bytes: Some(4096),
            },
        );
        let ResponseBody::Attached { replay, .. } = peer.response(3) else {
            panic!("attach should answer with the replay");
        };
        let before = peer.output.remove("ts-1").unwrap_or_default();
        t.on_output("ts-1", b"after");

        assert!(
            printed.starts_with(&before),
            "what arrived before the detach must be the start of the output"
        );
        assert_same_bytes(&decode(&replay), &printed[printed.len() - 4096..]);
        assert_same_bytes(&peer.output_of("ts-1", 5), b"after");
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
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap();
                        String::from_utf8_lossy(&bytes).contains("monica-fanout")
                    }
                    _ => false,
                }
            })
        });
        let _ = line;

        t.detach("ts-1", 1);
        assert!(t
            .lock()
            .attachments
            .get("ts-1")
            .is_none_or(|c| c.is_empty()));

        t.terminate("ts-1").unwrap();
        wait_for(Duration::from_secs(5), || {
            (!t.list().iter().any(|s| s.running)).then_some(())
        });
        std::fs::remove_dir_all(&dir).ok();
    }
}
