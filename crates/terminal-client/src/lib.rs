//! Client half of the daemon protocol: one persistent UnixStream, request/response
//! correlation by id, and a reader thread that forwards Output/Exit events.

use std::collections::HashMap;
use std::io::{BufReader, BufWriter};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};

use tania_terminal_protocol::{
    read_frames, write_frame, Request, RequestOp, ResponseBody, ServerMessage, PROTOCOL_VERSION,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub enum ClientEvent {
    Output {
        session_id: String,
        data: String,
    },
    Exit {
        session_id: String,
        exit_code: Option<i32>,
    },
    /// The daemon connection dropped; all in-flight requests have already failed.
    Disconnected,
}

type PendingMap = HashMap<u64, mpsc::SyncSender<Result<ResponseBody, String>>>;

struct ClientInner {
    writer: Mutex<BufWriter<UnixStream>>,
    pending: Mutex<PendingMap>,
    next_id: AtomicU64,
}

pub struct PtydClient {
    inner: Arc<ClientInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PtydClient {
    pub fn connect(
        socket_path: &Path,
        on_event: impl Fn(ClientEvent) + Send + 'static,
    ) -> Result<Self> {
        let stream = UnixStream::connect(socket_path)
            .with_context(|| format!("failed to connect to {}", socket_path.display()))?;
        let read_stream = stream
            .try_clone()
            .context("failed to clone daemon stream")?;
        let inner = Arc::new(ClientInner {
            writer: Mutex::new(BufWriter::new(stream)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        });

        let reader_inner = Arc::clone(&inner);
        std::thread::Builder::new()
            .name("ptyd-client-reader".to_string())
            .spawn(move || {
                let reader = BufReader::new(read_stream);
                // [DEBUG-lag] per-window stats of the reader: frames, time inside on_event, time
                // spent parsing (frame in hand → dispatched), and wall time.
                let mut win_start = std::time::Instant::now();
                let (mut frames, mut event_ns, mut max_event_ns, mut bytes) = (0u64, 0u128, 0u128, 0usize);
                let mut waited_ns = 0u128;
                let mut last_done = std::time::Instant::now();
                let mut frames_iter = read_frames::<_, ServerMessage>(reader);
                loop {
                    let Some(frame) = frames_iter.next() else { break };
                    let got = std::time::Instant::now();
                    waited_ns += (got - last_done).as_nanos();
                    if let Ok(ServerMessage::Output { data, .. }) = &frame {
                        bytes += data.len();
                    }
                    frames += 1;
                    // PROTOTYPE: `$TANIA_HOME/prototype-stall-ms` stalls this reader once, standing in
                    // for the OS hiccup that the incident's Shell had mid-burst.
                    if matches!(&frame, Ok(ServerMessage::Output { .. })) {
                        if let Some(home) = std::env::var_os("TANIA_HOME") {
                            let flag = std::path::Path::new(&home).join("prototype-stall-ms");
                            if let Ok(ms) = std::fs::read_to_string(&flag) {
                                let _ = std::fs::remove_file(&flag);
                                let ms: u64 = ms.trim().parse().unwrap_or(1000);
                                eprintln!("[DEBUG-lag] reader: injected stall {ms}ms");
                                std::thread::sleep(Duration::from_millis(ms));
                            }
                        }
                    }
                    let ev_start = std::time::Instant::now();
                    let is_output = matches!(&frame, Ok(ServerMessage::Output { .. }));
                    dispatch_frame(&reader_inner, &on_event, frame);
                    let ev = ev_start.elapsed().as_nanos();
                    if is_output {
                        event_ns += ev;
                        max_event_ns = max_event_ns.max(ev);
                    }
                    if ev > 20_000_000 {
                        eprintln!("[DEBUG-lag] reader: one frame took {}ms in on_event", ev / 1_000_000);
                    }
                    last_done = std::time::Instant::now();
                    let wall = win_start.elapsed();
                    if wall >= Duration::from_millis(500) && frames > 50 {
                        eprintln!(
                            "[DEBUG-lag] reader: {frames} frames {bytes}B in {}ms; on_event total {}ms max {}us; waiting on socket {}ms",
                            wall.as_millis(),
                            event_ns / 1_000_000,
                            max_event_ns / 1_000,
                            waited_ns / 1_000_000
                        );
                    }
                    if wall >= Duration::from_millis(500) {
                        win_start = std::time::Instant::now();
                        (frames, event_ns, max_event_ns, bytes, waited_ns) = (0, 0, 0, 0, 0);
                    }
                }
                for (_, tx) in lock(&reader_inner.pending).drain() {
                    let _ = tx.try_send(Err("daemon disconnected".to_string()));
                }
                on_event(ClientEvent::Disconnected);
            })
            .context("failed to spawn client reader thread")?;

        Ok(Self { inner })
    }
}

fn dispatch_frame(
    reader_inner: &Arc<ClientInner>,
    on_event: &impl Fn(ClientEvent),
    frame: Result<ServerMessage, tania_terminal_protocol::FrameError>,
) {
    let msg = match frame {
        Ok(msg) => msg,
        Err(e) => {
            log::warn!("unparseable daemon message {e}");
            return;
        }
    };
    match msg {
        ServerMessage::Ok { id, body } => {
            if let Some(tx) = lock(&reader_inner.pending).remove(&id) {
                let _ = tx.try_send(Ok(body));
            }
        }
        ServerMessage::Err { id, error } => {
            if let Some(tx) = lock(&reader_inner.pending).remove(&id) {
                let _ = tx.try_send(Err(error));
            }
        }
        ServerMessage::Output { session_id, data } => {
            on_event(ClientEvent::Output { session_id, data });
        }
        ServerMessage::Exit {
            session_id,
            exit_code,
        } => {
            on_event(ClientEvent::Exit {
                session_id,
                exit_code,
            });
        }
    }
}

impl PtydClient {
    /// Exchange protocol versions; returns the daemon's. The caller decides whether a
    /// mismatch means restarting the daemon.
    pub fn hello(&self) -> Result<u32> {
        match self.request(RequestOp::Hello {
            version: PROTOCOL_VERSION,
        })? {
            ResponseBody::Hello { version } => Ok(version),
            other => bail!("unexpected hello response: {other:?}"),
        }
    }

    pub fn request(&self, op: RequestOp) -> Result<ResponseBody> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        lock(&self.inner.pending).insert(id, tx);
        if let Err(e) = self.send_line(&Request { id: Some(id), op }) {
            lock(&self.inner.pending).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(body)) => Ok(body),
            Ok(Err(error)) => bail!("daemon error: {error}"),
            Err(_) => {
                lock(&self.inner.pending).remove(&id);
                bail!("daemon request timed out");
            }
        }
    }

    /// Fire-and-forget (write/resize/shutdown): no response, no round trip.
    pub fn notify(&self, op: RequestOp) -> Result<()> {
        self.send_line(&Request { id: None, op })
    }

    fn send_line(&self, request: &Request) -> Result<()> {
        let mut writer = lock(&self.inner.writer);
        write_frame(&mut *writer, request)?;
        Ok(())
    }
}
