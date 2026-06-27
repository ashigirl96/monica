use monica_api::{ApiError, ApiErrorCode};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::event_sink;
use crate::schedulers::pull_request_sync::PrSyncWaker;

#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "pr-sync:completed")]
pub struct PrSyncCompleted {
    pub synced_count: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn force_sync_pull_requests(
    app: AppHandle,
    waker: State<'_, PrSyncWaker>,
) -> Result<(), ApiError> {
    let mut monica = event_sink::open(&app)?;
    if !monica.synchronization().auth_status().authenticated {
        return Err(ApiError::new(
            ApiErrorCode::AuthenticationRequired,
            "Not authenticated with GitHub",
        ));
    }
    monica.synchronization().reset_pull_request_sync()?;
    if !waker.wake_forced() {
        return Err(ApiError::external("PR sync scheduler is not running"));
    }
    Ok(())
}
