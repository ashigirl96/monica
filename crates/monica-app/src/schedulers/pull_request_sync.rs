use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use tauri::AppHandle;

use crate::event_sink::TauriEventSink;

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
            let limit = if forced { PR_SYNC_FORCED_BATCH_LIMIT } else { PR_SYNC_BATCH_LIMIT };
            // Forced syncs announce completion (so the manual action confirms); the periodic sweep
            // stays quiet to avoid churning the frontend every interval.
            tauri::async_runtime::block_on(run_batch(app_handle.clone(), limit, forced));
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

async fn run_batch(app: AppHandle, limit: usize, announce: bool) {
    let mut monica = match monica_infra::open_monica(Box::new(TauriEventSink::new(app))) {
        Ok(monica) => monica,
        Err(e) => {
            log::error!(target: "monica_app::pr_sync", "failed to open façade for PR sync: {e:#}");
            return;
        }
    };
    if let Err(e) = monica.synchronization().sync_pull_requests(limit, announce).await {
        log::error!(target: "monica_app::pr_sync", "PR sync batch failed: {e}");
    }
}
