use monica_api::ApiError;
use monica_application::{ApplicationEvent, EventSink};
use tauri::AppHandle;
use tauri_specta::Event;

use crate::commands::pull_request::PrSyncCompleted;
use crate::commands::sdk::SdkSessionOpened;
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
            ApplicationEvent::SdkSessionOpened {
                runspace_id,
                tab_id,
                session_id,
                cwd,
                title,
                ..
            } => {
                let event = SdkSessionOpened { runspace_id, tab_id, session_id, cwd, title };
                if let Err(e) = event.emit(&self.app) {
                    log::warn!(target: "monica_app::events", "failed to emit SdkSessionOpened: {e}");
                }
            }
            // The desktop reflects a waiting run via its TaskRunStatusChanged status; no separate
            // OS notification yet.
            ApplicationEvent::AwaitingUserInput { .. } => {}
        }
    }
}
