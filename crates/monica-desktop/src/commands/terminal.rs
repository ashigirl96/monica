use monica_api::{ApiError, TerminalSession, TerminalSessionKind, TerminalStateSnapshot};
use monica_domain::NewTerminalSession;
use monica_terminal_protocol::RequestOp;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

#[derive(Serialize, specta::Type)]
pub struct AttachResult {
    /// Base64 transcript tail to write into xterm before streaming live output.
    pub replay: String,
    pub rows: u16,
    pub cols: u16,
}

pub(crate) fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_create_session(
    app: AppHandle,
    runspace_id: String,
    tab_id: String,
    kind: TerminalSessionKind,
    cwd: String,
    rows: u16,
    cols: u16,
    env: Option<Vec<(String, String)>>,
) -> Result<TerminalSession, ApiError> {
    event_sink::off_main(move || {
        let state = app.state::<PtydHandle>();
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
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_attach(
    app: AppHandle,
    session_id: String,
    replay_bytes: Option<u32>,
) -> Result<AttachResult, ApiError> {
    event_sink::off_main(move || {
        let state = app.state::<PtydHandle>();
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
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_detach(app: AppHandle, session_id: String) -> Result<(), ApiError> {
    event_sink::off_main(move || {
        let state = app.state::<PtydHandle>();
        let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
        let mut monica = event_sink::open(&app)?;
        Ok(monica.executions().detach_terminal_session(&daemon, &session_id)?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_write(
    app: AppHandle,
    session_id: String,
    data: String,
) -> Result<(), ApiError> {
    event_sink::off_main(move || {
        let client = app
            .state::<PtydHandle>()
            .ensure_connected(&app)
            .map_err(|e| ApiError::external(format!("{e:#}")))?;
        client
            .notify(RequestOp::Write { session_id, data })
            .map_err(|e| ApiError::external(e.to_string()))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_resize(
    app: AppHandle,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), ApiError> {
    event_sink::off_main(move || {
        let client = app
            .state::<PtydHandle>()
            .ensure_connected(&app)
            .map_err(|e| ApiError::external(format!("{e:#}")))?;
        client
            .notify(RequestOp::Resize { session_id, rows, cols })
            .map_err(|e| ApiError::external(e.to_string()))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_terminate(app: AppHandle, session_id: String) -> Result<(), ApiError> {
    event_sink::off_main(move || {
        let state = app.state::<PtydHandle>();
        let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
        let mut monica = event_sink::open(&app)?;
        Ok(monica.executions().terminate_terminal_session(&daemon, &session_id)?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_list_sessions(
    app: AppHandle,
    runspace_id: Option<String>,
) -> Result<Vec<TerminalSession>, ApiError> {
    event_sink::off_main(move || {
        let state = app.state::<PtydHandle>();
        let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .executions()
            .list_terminal_sessions(&daemon, runspace_id.as_deref())?
            .into_iter()
            .map(TerminalSession::from)
            .collect())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_load_state(
    app: AppHandle,
    window_label: String,
) -> Result<TerminalStateSnapshot, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .executions()
            .load_terminal_state(&window_label)?
            .into())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_save_state(
    app: AppHandle,
    window_label: String,
    state: TerminalStateSnapshot,
) -> Result<(), ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .executions()
            .save_terminal_state(&window_label, &state.into())?)
    })
    .await
}
