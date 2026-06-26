use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use monica_application::PullRequestSyncStatus;
use monica_infra::Runtime;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::commands::pull_request::PrSyncCompleted;

const PR_SYNC_INTERVAL: Duration = Duration::from_secs(10);
const PR_SYNC_BATCH_LIMIT: usize = 3;
const PR_SYNC_FORCED_BATCH_LIMIT: usize = 20;

pub struct PrSyncWaker(mpsc::SyncSender<bool>);

impl PrSyncWaker {
    pub fn wake_forced(&self) -> bool {
        self.0.try_send(true).is_ok()
    }
}

pub(crate) fn start(app_handle: AppHandle) -> PrSyncWaker {
    let in_flight = Arc::new(AtomicBool::new(false));
    let scheduler_in_flight = Arc::clone(&in_flight);
    let (tx, rx) = mpsc::sync_channel::<bool>(1);
    let spawn_result = std::thread::Builder::new()
        .name("monica-pr-sync".to_string())
        .spawn(move || loop {
            let forced = match rx.recv_timeout(PR_SYNC_INTERVAL) {
                Ok(f) => f,
                Err(mpsc::RecvTimeoutError::Timeout) => false,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if scheduler_in_flight.swap(true, Ordering::AcqRel) {
                continue;
            }
            let _guard = PullRequestSyncGuard(Arc::clone(&scheduler_in_flight));
            if forced {
                tauri::async_runtime::block_on(sync_pull_request_batch_forced(
                    app_handle.clone(),
                ));
            } else {
                tauri::async_runtime::block_on(sync_pull_request_batch_inner(PR_SYNC_BATCH_LIMIT));
            }
        });
    if let Err(e) = spawn_result {
        log::error!(target: "monica_app::pr_sync", "failed to start PR sync scheduler: {e}");
    }
    PrSyncWaker(tx)
}

struct PullRequestSyncGuard(Arc<AtomicBool>);

impl Drop for PullRequestSyncGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn sync_pull_request_batch_forced(app_handle: AppHandle) {
    let synced_count = sync_pull_request_batch_inner(PR_SYNC_FORCED_BATCH_LIMIT).await;
    let event = PrSyncCompleted { synced_count };
    if let Err(e) = event.emit(&app_handle) {
        log::warn!(target: "monica_app::pr_sync", "failed to emit PrSyncCompleted: {e}");
    }
}

async fn sync_pull_request_batch_inner(limit: usize) -> u32 {
    let mut runtime = match Runtime::open_default() {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error!(target: "monica_app::pr_sync", "failed to open runtime for PR sync: {e:#}");
            return 0;
        }
    };

    if !monica_application::github_auth_status(&runtime.auth).authenticated {
        return 0;
    }

    let mut synced_count = 0u32;
    for _ in 0..limit {
        let result =
            match monica_application::sync_next_pull_request(&mut runtime.repositories, &runtime.github)
                .await
            {
                Ok(result) => result,
                Err(e) => {
                    log::error!(target: "monica_app::pr_sync", "PR sync scheduler failed: {e:#}");
                    break;
                }
            };

        match result.status {
            PullRequestSyncStatus::Idle => {
                log::debug!(target: "monica_app::pr_sync", "PR sync scheduler idle");
                break;
            }
            PullRequestSyncStatus::Synced => {
                synced_count += 1;
                log::info!(
                    target: "monica_app::pr_sync",
                    "PR sync scheduler synced task_id={} pull_request_count={}",
                    result.task_id.as_deref().unwrap_or("-"),
                    result.pull_request_count
                );
            }
            PullRequestSyncStatus::Failed => {
                log::warn!(
                    target: "monica_app::pr_sync",
                    "PR sync scheduler recorded failure task_id={} error={}",
                    result.task_id.as_deref().unwrap_or("-"),
                    result.error.as_deref().unwrap_or("-")
                );
            }
        }
    }
    synced_count
}
