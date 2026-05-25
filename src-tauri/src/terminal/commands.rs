use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime};

use crate::terminal::SessionId;
use crate::terminal::manager::SessionManager;
use crate::terminal::pty::ShellSpec;

#[tauri::command]
pub async fn terminal_open<R: Runtime>(
    app: AppHandle<R>,
    rows: u16,
    cols: u16,
    channel: Channel<InvokeResponseBody>,
) -> Result<SessionId, String> {
    let manager = app.state::<SessionManager>();
    let shell = ShellSpec::from_env();
    manager.open(rows, cols, shell, channel)
}

#[tauri::command]
pub async fn terminal_write<R: Runtime>(
    app: AppHandle<R>,
    id: SessionId,
    data: String,
) -> Result<(), String> {
    let manager = app.state::<SessionManager>();
    let session = manager.get(id).ok_or_else(|| "session not found".to_string())?;
    session.write(data.as_bytes())
}

#[tauri::command]
pub async fn terminal_resize<R: Runtime>(
    app: AppHandle<R>,
    id: SessionId,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let manager = app.state::<SessionManager>();
    let session = manager.get(id).ok_or_else(|| "session not found".to_string())?;
    session.resize(rows, cols)
}

#[tauri::command]
pub async fn terminal_close<R: Runtime>(
    app: AppHandle<R>,
    id: SessionId,
) -> Result<(), String> {
    let manager = app.state::<SessionManager>();
    manager.close(id)
}
