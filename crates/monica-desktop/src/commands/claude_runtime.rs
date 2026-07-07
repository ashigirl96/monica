use monica_api::{
    ApiError, ClaudeConversationStatus, ClaudeSession, ClaudeSessionStatus,
    ClaudeTranscriptRecord, TaskRunWaitReason,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

/// Announces an Agent Runtime-created terminal session so the Workbench can adopt a tab bound to it.
/// Purely observational: the session row, PTY spawn, and Claude launch are already handled
/// backend-side by the time this fires.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "claude-session:opened")]
pub struct ClaudeSessionOpened {
    pub(crate) runspace_id: String,
    pub(crate) tab_id: String,
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    pub(crate) title: Option<String>,
}

/// A Claude Runtime session's observable state moved (hook-driven): the conversation
/// went idle/thinking/awaiting-user, or the session ended.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "claude-session:state-changed")]
pub struct ClaudeSessionStateChanged {
    pub(crate) claude_session_id: String,
    pub(crate) tab_id: String,
    pub(crate) session_status: ClaudeSessionStatus,
    pub(crate) conversation_status: ClaudeConversationStatus,
    pub(crate) wait_reason: Option<TaskRunWaitReason>,
    pub(crate) subagents_running: bool,
}

/// New transcript records (assistant text / tool uses) read after a completed turn.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "claude-session:message")]
pub struct ClaudeSessionMessage {
    pub(crate) claude_session_id: String,
    pub(crate) records: Vec<ClaudeTranscriptRecord>,
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
