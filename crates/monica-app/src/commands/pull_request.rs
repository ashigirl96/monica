use monica_infra::Runtime;
use serde::Serialize;
use tauri_specta::Event;

use crate::schedulers::pull_request_sync::PrSyncWaker;

#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "pr-sync:completed")]
pub struct PrSyncCompleted {
    pub synced_count: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn force_sync_pull_requests(
    waker: tauri::State<'_, PrSyncWaker>,
) -> Result<(), String> {
    log::info!(target: "monica_app::debug", "force_sync_pull_requests command invoked");
    let mut rt = Runtime::open_default().map_err(|e| e.to_string())?;
    if !monica_core::github_auth_status(&rt.auth).authenticated {
        return Err("Not authenticated with GitHub".to_string());
    }
    rt.repositories
        .force_clear_pr_sync_state()
        .map_err(|e| e.to_string())?;
    let woke = waker.wake_forced();
    log::info!(target: "monica_app::debug", "force_sync_pull_requests wake_forced={woke}");
    if !woke {
        return Err("PR sync scheduler is not running".to_string());
    }
    Ok(())
}
