//! Client half of the daemon protocol: one persistent UnixStream, request/response
//! correlation by id, and a reader thread that forwards Output/Exit events.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};

use crate::protocol::{Request, RequestOp, ResponseBody, ServerMessage, PROTOCOL_VERSION};

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
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PtydClient {
    pub fn connect(
        socket_path: &Path,
        on_event: impl Fn(ClientEvent) + Send + 'static,
    ) -> Result<Self> {
        let stream = UnixStream::connect(socket_path)
            .with_context(|| format!("failed to connect to {}", socket_path.display()))?;
        let read_stream = stream.try_clone().context("failed to clone daemon stream")?;
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
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<ServerMessage>(&line) {
                        Ok(ServerMessage::Ok { id, body }) => {
                            if let Some(tx) = lock(&reader_inner.pending).remove(&id) {
                                let _ = tx.try_send(Ok(body));
                            }
                        }
                        Ok(ServerMessage::Err { id, error }) => {
                            if let Some(tx) = lock(&reader_inner.pending).remove(&id) {
                                let _ = tx.try_send(Err(error));
                            }
                        }
                        Ok(ServerMessage::Output { session_id, data }) => {
                            on_event(ClientEvent::Output { session_id, data });
                        }
                        Ok(ServerMessage::Exit {
                            session_id,
                            exit_code,
                        }) => {
                            on_event(ClientEvent::Exit {
                                session_id,
                                exit_code,
                            });
                        }
                        Err(e) => log::warn!("unparseable daemon message ({e}): {line}"),
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
        let line = serde_json::to_string(request)?;
        let mut writer = lock(&self.inner.writer);
        writer.write_all(line.as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(())
    }
}
