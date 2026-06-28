use monica_api::ApiError;
use tauri::AppHandle;

use crate::services;

#[tauri::command]
#[specta::specta]
pub async fn open_named_window(app: AppHandle, label: String) -> Result<(), ApiError> {
    services::window_manager::open_named_window(app, label).await
}
