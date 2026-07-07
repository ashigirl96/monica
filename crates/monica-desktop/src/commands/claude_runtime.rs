use monica_api::{
    ApiError, ClaudeConversationStatus, ClaudeSession, ClaudeSessionStatus,
    ClaudeTranscriptRecord, TaskRunWaitReason,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::event_sink;
use crate::ptyd::{PtydHandle, PtydTerminalDaemon};

/// The HOME the transcript JSONL path derives from — resolved here so path knowledge
/// stays out of the webview.
pub(crate) fn home_dir() -> Result<std::path::PathBuf, ApiError> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| ApiError::external("HOME is not set".to_string()))
}

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
}

/// New transcript records (assistant text / tool uses) read after a completed turn.
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "claude-session:message")]
pub struct ClaudeSessionMessage {
    pub(crate) claude_session_id: String,
    pub(crate) records: Vec<ClaudeTranscriptRecord>,
}

/// Full transcript of a Claude Runtime session — pull-style catch-up for a frontend that
/// missed the push events (fresh window, restart).
#[tauri::command]
#[specta::specta]
pub async fn claude_session_transcript(
    app: AppHandle,
    claude_session_id: String,
) -> Result<Vec<ClaudeTranscriptRecord>, ApiError> {
    event_sink::off_main(move || {
        let home = home_dir()?;
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .executions()
            .claude_session_transcript(&home, &claude_session_id)?
            .into_iter()
            .map(ClaudeTranscriptRecord::from)
            .collect())
    })
    .await
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
