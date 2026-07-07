use monica_api::{ApiError, ClaudeSession};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

/// Announces an SDK-created terminal session so the Workbench can adopt a tab bound to it.
/// Purely observational: the session row, PTY spawn, and Claude launch are already handled
/// backend-side by the time this fires.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "sdk-session:opened")]
pub struct SdkSessionOpened {
    pub(crate) runspace_id: String,
    pub(crate) tab_id: String,
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) title: Option<String>,
}

/// The persisted Claude session mappings, with liveness reconciled against the daemon
/// first — startup recovery adopts the rows still `active` as Workbench tabs.
#[tauri::command]
#[specta::specta]
pub async fn claude_list_sessions(app: AppHandle) -> Result<Vec<ClaudeSession>, ApiError> {
    event_sink::off_main(move || {
        let state = app.state::<PtydHandle>();
        let daemon = PtydTerminalDaemon { handle: state.inner(), app: &app };
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .executions()
            .list_claude_sessions(&daemon)?
            .into_iter()
            .map(ClaudeSession::from)
            .collect())
    })
    .await
}
