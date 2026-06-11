use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use monica_core::PullRequestSyncStatus;
use monica_infra::Runtime;

const PR_SYNC_INTERVAL: Duration = Duration::from_secs(10);
const PR_SYNC_BATCH_LIMIT: usize = 3;

pub(crate) fn start() {
    let in_flight = Arc::new(AtomicBool::new(false));
    let scheduler_in_flight = Arc::clone(&in_flight);
    let spawn_result = std::thread::Builder::new()
        .name("monica-pr-sync".to_string())
        .spawn(move || loop {
            std::thread::sleep(PR_SYNC_INTERVAL);
            if scheduler_in_flight.swap(true, Ordering::AcqRel) {
                continue;
            }
            let _guard = PullRequestSyncGuard(Arc::clone(&scheduler_in_flight));
            tauri::async_runtime::block_on(sync_pull_request_batch(PR_SYNC_BATCH_LIMIT));
        });
    if let Err(e) = spawn_result {
        log::error!(target: "monica_app::pr_sync", "failed to start PR sync scheduler: {e}");
    }
}

struct PullRequestSyncGuard(Arc<AtomicBool>);

impl Drop for PullRequestSyncGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn sync_pull_request_batch(limit: usize) {
    let mut runtime = match Runtime::open_default() {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error!(target: "monica_app::pr_sync", "failed to open runtime for PR sync: {e:#}");
            return;
        }
    };

    if !monica_core::github_auth_status(&runtime.auth).authenticated {
        return;
    }

    for _ in 0..limit {
        let result =
            match monica_core::sync_next_pull_request(&mut runtime.repositories, &runtime.github)
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
}
