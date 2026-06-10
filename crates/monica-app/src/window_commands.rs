use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, WebviewWindowBuilder};

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
#[specta::specta]
pub fn open_runspace_window(app: AppHandle, cwd: String) -> Result<(), String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "no base window config".to_string())?;
    config.label = format!("runspace-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    // The base config keeps the main window non-closable; satellites must be closable.
    config.closable = true;
    let cwd_json = serde_json::to_string(&cwd).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| e.to_string())?
        .initialization_script(format!("window.__MONICA_RUNSPACE_CWD__ = {cwd_json};"))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
