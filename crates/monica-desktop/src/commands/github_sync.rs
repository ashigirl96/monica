use monica_api::{ApiError, ApiErrorCode};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::event_sink;
use crate::schedulers::github_sync::GithubSyncWaker;

#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "github-sync:completed")]
pub struct GithubSyncCompleted {
    pub synced_count: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn force_sync_github(
    app: AppHandle,
    waker: State<'_, GithubSyncWaker>,
) -> Result<(), ApiError> {
    // auth_status shells out to `gh` on a cold cache, which can block on a
    // Keychain prompt; keep it (and the SQLite open) off the async runtime.
    let status = tauri::async_runtime::spawn_blocking(move || {
        event_sink::open(&app).map(|mut monica| monica.synchronization().auth_status())
    })
    .await
    .map_err(|e| ApiError::external(format!("GitHub auth check failed: {e}")))??;
    if !status.authenticated {
        return Err(ApiError::new(
            ApiErrorCode::AuthenticationRequired,
            status
                .message
                .as_deref()
                .unwrap_or("Not authenticated with GitHub"),
        ));
    }
    if !waker.wake_forced() {
        return Err(ApiError::external("GitHub sync worker is not running"));
    }
    Ok(())
}
