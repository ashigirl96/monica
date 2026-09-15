use monica_api::ApiError;
use tauri::AppHandle;

use crate::command_log::{self, ids};
use crate::services;

#[tauri::command]
#[specta::specta]
pub async fn open_named_window(app: AppHandle, label: String) -> Result<(), ApiError> {
    let log_ids = ids![label];
    command_log::operation("open_named_window", log_ids, async move {
        services::window_manager::open_named_window(app, label).await
    })
    .await
}
