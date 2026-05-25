use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::terminal::SessionId;
use crate::terminal::pty::ShellSpec;
use crate::terminal::session::Session;

pub struct SessionManager {
    sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    next_id: AtomicU32,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self { sessions: RwLock::new(HashMap::new()), next_id: AtomicU32::new(1) }
    }

    pub fn open(
        &self,
        rows: u16,
        cols: u16,
        shell: ShellSpec,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<SessionId, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let session = Session::open(id, rows, cols, &shell, channel)?;
        let mut map = self
            .sessions
            .write()
            .map_err(|_| "session manager poisoned".to_string())?;
        map.insert(id, Arc::new(session));
        Ok(id)
    }

    pub fn get(&self, id: SessionId) -> Option<Arc<Session>> {
        self.sessions.read().ok()?.get(&id).cloned()
    }

    pub fn close(&self, id: SessionId) -> Result<(), String> {
        let mut map = self
            .sessions
            .write()
            .map_err(|_| "session manager poisoned".to_string())?;
        if let Some(session) = map.remove(&id) {
            session.shutdown();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let mut map = match self.sessions.write() {
            Ok(m) => m,
            Err(_) => return,
        };
        for (_, session) in map.drain() {
            session.shutdown();
        }
    }
}
