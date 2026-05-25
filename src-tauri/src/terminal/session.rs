use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::terminal::SessionId;
use crate::terminal::pty::{self, PtyHandle, ShellSpec};
use crate::terminal::reader;

pub struct Session {
    #[allow(dead_code)]
    pub id: SessionId,
    pub pty: Arc<PtyHandle>,
}

impl Session {
    pub fn open(
        id: SessionId,
        rows: u16,
        cols: u16,
        shell: &ShellSpec,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<Self, String> {
        let (pty_handle, reader_stream) = pty::spawn(rows, cols, shell)?;
        let pty = Arc::new(pty_handle);
        reader::spawn_reader_thread(reader_stream, channel, move || {});
        Ok(Self { id, pty })
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        self.pty.resize(rows, cols)
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.pty.write_all(data)
    }

    pub fn shutdown(&self) {
        self.pty.kill().ok();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.pty.kill().ok();
    }
}
