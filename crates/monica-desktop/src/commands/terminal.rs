use monica_api::{ApiError, TerminalSession, TerminalSessionKind, TerminalStateSnapshot};
use monica_application::NewTerminalSession;
use monica_terminal_protocol::RequestOp;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

#[derive(Serialize, specta::Type)]
pub struct AttachResult {
    /// Base64 transcript tail to write into xterm before streaming live output.
    pub replay: String,
    pub rows: u16,
    pub cols: u16,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn terminal_create_session(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    runspace_id: String,
    tab_id: String,
    kind: TerminalSessionKind,
    cwd: String,
    rows: u16,
    cols: u16,
    env: Option<Vec<(String, String)>>,
) -> Result<TerminalSession, ApiError> {
    let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
    let new = NewTerminalSession {
        runspace_id: Some(runspace_id),
        tab_id: Some(tab_id),
        kind: kind.into(),
        cwd,
        shell: default_shell(),
        rows,
        cols,
    };
    let mut monica = event_sink::open(&app)?;
    let session = monica
        .executions()
        .create_terminal_session(&daemon, new, env.unwrap_or_default())?;
    Ok(TerminalSession::from(session))
}

#[tauri::command]
#[specta::specta]
pub fn terminal_attach(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
    replay_bytes: Option<u32>,
) -> Result<AttachResult, ApiError> {
    let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
    let mut monica = event_sink::open(&app)?;
    let attachment = monica
        .executions()
        .attach_terminal_session(&daemon, &session_id, replay_bytes)?;
    Ok(AttachResult {
        replay: attachment.replay,
        rows: attachment.rows,
        cols: attachment.cols,
    })
}

#[tauri::command]
#[specta::specta]
pub fn terminal_detach(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
) -> Result<(), ApiError> {
    let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
    let mut monica = event_sink::open(&app)?;
    Ok(monica.executions().detach_terminal_session(&daemon, &session_id)?)
}

// Write/resize are per-keystroke daemon I/O that never touch SQLite, so they stay a thin daemon
// notify rather than opening the façade on every keypress.
#[tauri::command]
#[specta::specta]
pub fn terminal_write(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
    data: String,
) -> Result<(), ApiError> {
    let client = state
        .ensure_connected(&app)
        .map_err(|e| ApiError::external(format!("{e:#}")))?;
    client
        .notify(RequestOp::Write { session_id, data })
        .map_err(|e| ApiError::external(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn terminal_resize(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), ApiError> {
    let client = state
        .ensure_connected(&app)
        .map_err(|e| ApiError::external(format!("{e:#}")))?;
    client
        .notify(RequestOp::Resize { session_id, rows, cols })
        .map_err(|e| ApiError::external(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn terminal_terminate(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    session_id: String,
) -> Result<(), ApiError> {
    let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
    let mut monica = event_sink::open(&app)?;
    Ok(monica.executions().terminate_terminal_session(&daemon, &session_id)?)
}

#[tauri::command]
#[specta::specta]
pub fn terminal_list_sessions(
    state: State<'_, PtydHandle>,
    app: AppHandle,
    runspace_id: Option<String>,
) -> Result<Vec<TerminalSession>, ApiError> {
    let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
    let mut monica = event_sink::open(&app)?;
    Ok(monica
        .executions()
        .list_terminal_sessions(&daemon, runspace_id.as_deref())?
        .into_iter()
        .map(TerminalSession::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_load_state(app: AppHandle) -> Result<TerminalStateSnapshot, ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica.executions().load_terminal_state()?.into())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_save_state(app: AppHandle, state: TerminalStateSnapshot) -> Result<(), ApiError> {
    let mut monica = event_sink::open(&app)?;
    Ok(monica.executions().save_terminal_state(&state.into())?)
}
