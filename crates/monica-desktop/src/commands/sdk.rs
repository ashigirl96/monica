use serde::Serialize;
use tauri_specta::Event;

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
