use monica_api::ApiError;
use monica_application::{ApplicationEvent, EventSink};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::commands::pull_request::PrSyncCompleted;
use crate::commands::claude_runtime::{
    ClaudeSessionMessage, ClaudeSessionOpened, ClaudeSessionStateChanged,
};
use crate::commands::task::TaskRunStatusChanged;

/// The application façade wired to the default backend and the Tauri event sink.
pub type AppMonica = monica_runtime::MonicaFacade;

/// Open the façade for a command/thread. The façade owns a SQLite connection and is `!Send`, so it
/// must be built per operation on the thread that uses it — never stored in Tauri state.
pub fn open(app: &AppHandle) -> Result<AppMonica, ApiError> {
    monica_runtime::open_monica(Box::new(TauriEventSink::new(app.clone())))
        .map_err(|e| ApiError::storage(format!("{e:#}")))
}

/// Run a blocking closure off the main thread. Every `#[tauri::command]` that does I/O
/// (SQLite, daemon IPC, filesystem) should use this to avoid the WKWebView deadlock where
/// a URL-scheme handler blocks the main RunLoop while WebKit needs it for `didReceiveData`.
pub async fn off_main<F, T>(f: F) -> Result<T, ApiError>
where
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::external(e.to_string()))?
}

/// Bridges [`ApplicationEvent`]s to the webview as tauri-specta events. Raw PTY byte/exit streams
/// are not application events — they stay in `ptyd`.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: ApplicationEvent) {
        match event {
            ApplicationEvent::TaskRunStatusChanged { task_id, task_run_id, status } => {
                let _ = TaskRunStatusChanged {
                    task_id,
                    task_run_id,
                    status: status.into(),
                }
                .emit(&self.app);
            }
            ApplicationEvent::PullRequestSyncCompleted { synced_count } => {
                if let Err(e) = (PrSyncCompleted { synced_count }).emit(&self.app) {
                    log::warn!(target: "monica_app::events", "failed to emit PrSyncCompleted: {e}");
                }
            }
            ApplicationEvent::ClaudeSessionOpened {
                runspace_id,
                tab_id,
                session_id,
                cwd,
                title,
                ..
            } => {
                let event = ClaudeSessionOpened { runspace_id, tab_id, session_id, cwd, title };
                if let Err(e) = event.emit(&self.app) {
                    log::warn!(target: "monica_app::events", "failed to emit ClaudeSessionOpened: {e}");
                }
            }
            // The desktop reflects a waiting run via its TaskRunStatusChanged status; no separate
            // OS notification yet.
            ApplicationEvent::AwaitingUserInput { .. } => {}
            ApplicationEvent::ClaudeSessionStateChanged {
                claude_session_id,
                tab_id,
                session_status,
                conversation_status,
                wait_reason,
            } => {
                let event = ClaudeSessionStateChanged {
                    claude_session_id,
                    tab_id,
                    session_status: session_status.into(),
                    conversation_status: conversation_status.into(),
                    wait_reason: wait_reason.map(Into::into),
                };
                if let Err(e) = event.emit(&self.app) {
                    log::warn!(
                        target: "monica_app::events",
                        "failed to emit ClaudeSessionStateChanged: {e}"
                    );
                }
            }
            ApplicationEvent::ClaudeSessionMessages { claude_session_id, records } => {
                let event = ClaudeSessionMessage {
                    claude_session_id,
                    records: records.into_iter().map(Into::into).collect(),
                };
                if let Err(e) = event.emit(&self.app) {
                    log::warn!(
                        target: "monica_app::events",
                        "failed to emit ClaudeSessionMessage: {e}"
                    );
                }
            }
        }
    }
}
