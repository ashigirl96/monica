use std::collections::HashMap;
use std::fs::{self, DirBuilder, File};
use std::io::{BufRead, BufReader, Read};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use base64::prelude::*;
use monica_terminal_protocol::{write_frame, RequestOp, ResponseBody, PROTOCOL_VERSION};
use serde::Deserialize;
use serde_json::json;

use crate::renderer::{RendererGeneration, Renderers};
use crate::{lock, ClientEvent, PtydClient};

const CHUNK: usize = 45 * 1024;
const DRAW_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Default)]
pub struct Sizes(Mutex<HashMap<String, Arc<Mutex<Size>>>>);

#[derive(Default, Clone, PartialEq)]
struct Size {
    generation: u64,
    requested: Option<(u16, u16)>,
}

impl Sizes {
    fn subscribe(&self, session: &str) -> Arc<Mutex<Size>> {
        lock(&self.0).entry(session.into()).or_default().clone()
    }

    pub fn resize(&self, client: &PtydClient, session: String, rows: u16, cols: u16) -> Result<()> {
        let subscription = self.subscribe(&session);
        let mut size = lock(&subscription);
        client.notify(RequestOp::Resize {
            session_id: session,
            rows,
            cols,
        })?;
        size.generation += 1;
        size.requested = Some((rows, cols));
        Ok(())
    }
}

pub struct RemoteServer {
    pub path: PathBuf,
    secret: String,
    stopped: Arc<AtomicBool>,
    connections: Arc<Mutex<HashMap<u64, UnixStream>>>,
    listener: Option<JoinHandle<()>>,
}

impl RemoteServer {
    pub fn start(ptyd: PathBuf, sizes: Arc<Sizes>, renderers: Arc<Renderers>) -> Result<Self> {
        let mut random = [0u8; 48];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let secret: String = random[..32]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let name: String = random[32..]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let directory = PathBuf::from(format!("/tmp/monica-shell-{name}"));
        DirBuilder::new().mode(0o700).create(&directory)?;
        let path = directory.join("remote.sock");
        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(Mutex::new(HashMap::new()));
        let stop = stopped.clone();
        let active = connections.clone();
        let credential = secret.clone();
        let handle = thread::spawn(move || {
            let mut workers = Vec::new();
            let mut next = 0;
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if !same_uid(&stream) {
                            continue;
                        }
                        let Ok(shutdown) = stream.try_clone() else {
                            continue;
                        };
                        next += 1;
                        let id = next;
                        lock(&active).insert(id, shutdown);
                        let active = active.clone();
                        let secret = credential.clone();
                        let ptyd = ptyd.clone();
                        let sizes = sizes.clone();
                        let renderers = renderers.clone();
                        workers.push(thread::spawn(move || {
                            let _ = serve(stream, &ptyd, &secret, &sizes, renderers);
                            lock(&active).remove(&id);
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
                let mut index = 0;
                while index < workers.len() {
                    if workers[index].is_finished() {
                        let _ = workers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
            }
            for stream in lock(&active).values() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        Ok(Self {
            path,
            secret,
            stopped,
            connections,
            listener: Some(handle),
        })
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        for stream in lock(&self.connections).values() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
        if let Some(directory) = self.path.parent() {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

fn same_uid(stream: &UnixStream) -> bool {
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: both outputs are valid pointers; the stream owns its descriptor.
        unsafe {
            libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid()
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: credentials and length point to live, correctly sized storage.
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut len,
            ) == 0
                && credentials.uid == libc::geteuid()
        }
    }
}

fn frame(reader: &mut BufReader<UnixStream>) -> Result<serde_json::Value> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            bail!("remote EOF");
        }
        let count = available
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > 90_112 {
            bail!("remote message too large");
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return Ok(serde_json::from_slice(&bytes)?);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    secret: String,
    session: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Ack {
        sequence: u64,
    },
    Close,
    Prepare,
    Input {
        id: u64,
        data: String,
        generation: RendererGeneration,
    },
}

enum Output {
    Data(Vec<u8>),
    Exit(Option<i32>),
    Lost,
}

fn serve(
    mut stream: UnixStream,
    ptyd: &Path,
    secret: &str,
    sizes: &Sizes,
    renderers: Arc<Renderers>,
) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(DRAW_TIMEOUT))?;
    stream.set_write_timeout(Some(DRAW_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let open: Open = serde_json::from_value(frame(&mut reader)?)?;
    if open.secret.len() != secret.len()
        || open
            .secret
            .bytes()
            .zip(secret.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            != 0
        || open.session.is_empty()
        || open.session.len() > 128
    {
        bail!("unauthorized Shell attachment");
    }
    stream.set_read_timeout(None)?;
    let generation = sizes.subscribe(&open.session);
    let (output_tx, output) = mpsc::sync_channel(8);
    let abort_stream = stream.try_clone()?;
    let session = open.session.clone();
    let client = Arc::new(PtydClient::connect(ptyd, move |event| {
        let send = |value| {
            if output_tx.try_send(value).is_err() {
                let _ = abort_stream.shutdown(Shutdown::Both);
            }
        };
        match event {
            ClientEvent::Output { session_id, data } if session_id == session => {
                match BASE64_STANDARD.decode(data) {
                    Ok(bytes) => {
                        for chunk in bytes.chunks(CHUNK) {
                            send(Output::Data(chunk.to_vec()));
                        }
                    }
                    Err(_) => {
                        let _ = abort_stream.shutdown(Shutdown::Both);
                    }
                }
            }
            ClientEvent::Exit {
                session_id,
                exit_code,
            } if session_id == session => send(Output::Exit(exit_code)),
            ClientEvent::Disconnected => send(Output::Lost),
            _ => {}
        }
    })?);
    let (control_tx, control) = mpsc::sync_channel(1);
    let closing = Arc::new(AtomicBool::new(false));
    let closed = closing.clone();
    let input_client = client.clone();
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let input_writer = writer.clone();
    let input_renderers = renderers.clone();
    let input_session = open.session.clone();
    let preparing = Arc::new(AtomicBool::new(false));
    let input_preparing = preparing.clone();
    let input = thread::spawn(move || {
        let mut last_input = 0;
        while let Ok(value) = frame(&mut reader) {
            match serde_json::from_value::<Control>(value) {
                Ok(Control::Ack { sequence }) => {
                    if control_tx.try_send(sequence).is_err() {
                        break;
                    }
                }
                Ok(Control::Prepare) => {
                    input_preparing.store(true, Ordering::SeqCst);
                    input_renderers.request(&input_session);
                }
                Ok(Control::Input {
                    id,
                    data,
                    generation,
                }) => {
                    if id <= last_input {
                        break;
                    }
                    last_input = id;
                    let Ok(bytes) = BASE64_STANDARD.decode(&data) else {
                        break;
                    };
                    if bytes.len() > 65536 {
                        break;
                    }
                    let result = input_renderers.admit(&input_session, generation, || {
                        input_client.notify(RequestOp::Write {
                            session_id: input_session.clone(),
                            data,
                        })
                    });
                    let result = match result {
                        None => "not-sent",
                        Some(Ok(())) => "accepted",
                        Some(Err(_)) => "uncertain",
                    };
                    if write_frame(
                        &mut *lock(&input_writer),
                        &json!({"version":1,"type":"input_result","id":id,"result":result}),
                    )
                    .is_err()
                    {
                        break;
                    }
                }
                _ => break,
            }
        }
        closed.store(true, Ordering::SeqCst);
        let _ = input_client.close();
    });
    let result = (|| {
        if client.hello()? != PROTOCOL_VERSION {
            bail!("incompatible ptyd");
        }
        let attached_generation = lock(&generation).generation;
        let (replay, rows, cols) = match client.request(RequestOp::Attach {
            session_id: open.session.clone(),
            replay_bytes: None,
        })? {
            ResponseBody::Attached { replay, rows, cols } if rows > 0 && cols > 0 => {
                (BASE64_STANDARD.decode(replay)?, rows, cols)
            }
            _ => bail!("unexpected attach response"),
        };
        let mut sequence = 0;
        let mut send = |mut value: serde_json::Value| -> Result<()> {
            if closing.load(Ordering::SeqCst) {
                bail!("remote closed");
            }
            sequence += 1;
            value["sequence"] = json!(sequence);
            value["version"] = json!(1);
            write_frame(&mut *lock(&writer), &value)?;
            if control.recv_timeout(DRAW_TIMEOUT)? != sequence {
                bail!("invalid draw ACK");
            }
            Ok(())
        };
        let mut applied = None;
        let mut live = true;
        let mut size = || -> Result<Option<serde_json::Value>> {
            let deadline = Instant::now() + DRAW_TIMEOUT;
            loop {
                let current = lock(&generation).clone();
                if !live || Some(current.generation) == applied {
                    return Ok(None);
                }
                let sessions = match client.request(RequestOp::List)? {
                    ResponseBody::Sessions { sessions } => sessions,
                    _ => bail!("unexpected size read-back"),
                };
                if current != *lock(&generation) {
                    continue;
                }
                let Some(session) = sessions
                    .iter()
                    .find(|s| s.session_id == open.session && s.running)
                else {
                    live = false;
                    return Ok(applied.is_none().then(|| {
                        json!({"type":"size", "generation":attached_generation, "rows":rows, "cols":cols})
                    }));
                };
                if session.rows == 0 || session.cols == 0 {
                    bail!("invalid size read-back");
                }
                if current
                    .requested
                    .is_some_and(|requested| requested != (session.rows, session.cols))
                {
                    if Instant::now() >= deadline {
                        bail!("size read-back did not converge");
                    }
                    thread::sleep(Duration::from_millis(20));
                    continue;
                }
                applied = Some(current.generation);
                return Ok(Some(
                    json!({"type":"size", "generation":current.generation, "rows":session.rows, "cols":session.cols}),
                ));
            }
        };
        if let Some(value) = size()? {
            send(value)?;
        }
        for chunk in replay.chunks(CHUNK) {
            send(json!({"type":"output", "data":BASE64_STANDARD.encode(chunk)}))?;
        }
        send(json!({"type":"replay_end"}))?;
        let mut readiness = None;
        let mut reported = false;
        loop {
            if preparing.load(Ordering::SeqCst) {
                let current = renderers.current(&open.session, Instant::now());
                if !reported || current != readiness {
                    write_frame(
                        &mut *lock(&writer),
                        &json!({"version":1,"type":"renderer","generation":current}),
                    )?;
                    readiness = current;
                    reported = true;
                }
            }
            if closing.load(Ordering::SeqCst) {
                break;
            }
            if let Some(value) = size()? {
                send(value)?;
            }
            match output.recv_timeout(Duration::from_millis(20)) {
                Ok(Output::Data(bytes)) => {
                    send(json!({"type":"output", "data":BASE64_STANDARD.encode(bytes)}))?
                }
                Ok(Output::Exit(code)) => {
                    send(json!({"type":"exit", "exitCode":code}))?;
                    break;
                }
                Ok(Output::Lost) => bail!("daemon disconnected"),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        Ok(())
    })();
    closing.store(true, Ordering::SeqCst);
    let cleanup = client.close();
    let _ = stream.shutdown(Shutdown::Read);
    let joined = input.join();
    if cleanup.is_ok() && joined.is_ok() {
        let _ = write_frame(&mut stream, &json!({"type":"closed", "version":1}));
    }
    let _ = stream.shutdown(Shutdown::Both);
    result
}
