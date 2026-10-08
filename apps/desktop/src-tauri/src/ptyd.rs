//! ptyd の起動と reap は Backend が持ち、ここで reap すると Backend の exit の記録と競るので、Shell の接続は byte を運ぶだけにする。

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use monica_terminal_client::{ClientEvent, PtydClient};
use monica_terminal_protocol::PROTOCOL_VERSION;
use tauri::{AppHandle, Emitter, Manager};

use crate::locations;

// attach は Backend が返した layout の後にしか来ないので、待つのは Backend が ptyd を入れ替えている間だけでよい。
const CONNECT_RETRY_WINDOW: Duration = Duration::from_secs(2);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(50);

pub struct PtydHandle {
    client: Mutex<Option<Arc<PtydClient>>>,
}

impl PtydHandle {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }

    fn guard(&self) -> MutexGuard<'_, Option<Arc<PtydClient>>> {
        self.client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mark_disconnected(&self) {
        *self.guard() = None;
    }

    pub fn ensure_connected(&self, app: &AppHandle) -> Result<Arc<PtydClient>> {
        let mut guard = self.guard();
        if let Some(client) = guard.as_ref() {
            return Ok(Arc::clone(client));
        }
        let client = wait_for_connect(app, &locations::monica_home().join("ptyd.sock"))?;
        let version = client.hello().context("daemon handshake failed")?;
        if version != PROTOCOL_VERSION {
            bail!("monica-ptyd speaks protocol {version} (want {PROTOCOL_VERSION}); the Backend replaces it");
        }
        *guard = Some(Arc::clone(&client));
        Ok(client)
    }
}

fn wait_for_connect(app: &AppHandle, socket: &Path) -> Result<Arc<PtydClient>> {
    let deadline = Instant::now() + CONNECT_RETRY_WINDOW;
    loop {
        match try_connect(app, socket) {
            Ok(client) => return Ok(client),
            Err(e) if Instant::now() >= deadline => {
                return Err(e).context("monica-ptyd is not running (the Backend starts it)")
            }
            Err(_) => std::thread::sleep(CONNECT_RETRY_INTERVAL),
        }
    }
}

fn try_connect(app: &AppHandle, socket: &Path) -> Result<Arc<PtydClient>> {
    let app = app.clone();
    let client = PtydClient::connect(socket, move |event| handle_event(&app, event))?;
    Ok(Arc::new(client))
}

fn handle_event(app: &AppHandle, event: ClientEvent) {
    match event {
        ClientEvent::Output { session_id, data } => {
            let _ = app.emit(&format!("terminal:output:{session_id}"), &data);
        }
        // 行の記録は Backend が自分の接続で受けた Exit で行うので、ここでは pane に知らせるだけ。
        ClientEvent::Exit {
            session_id,
            exit_code,
        } => {
            if let Err(e) = app.emit(&format!("terminal:exit:{session_id}"), &exit_code) {
                eprintln!("[monica-desktop] failed to emit terminal exit {session_id}: {e}");
            }
        }
        ClientEvent::Disconnected => {
            eprintln!("[monica-desktop] monica-ptyd connection lost");
            app.state::<PtydHandle>().mark_disconnected();
        }
    }
}
