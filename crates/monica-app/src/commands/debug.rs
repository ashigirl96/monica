/// Temporary diagnostic sink so the release webview (which has no devtools) can route
/// frontend trace points into ~/monica/logs/monica.log. Tracked in issue #157; remove
/// once the cmd+r PR-sync investigation concludes.
#[tauri::command]
#[specta::specta]
pub fn debug_log(message: String) {
    log::info!(target: "monica_app::debug", "{message}");
}
