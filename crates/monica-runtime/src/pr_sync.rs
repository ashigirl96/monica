//! The PR-sync interval worker. Owns the timer, the in-flight guard, and the forced-wake channel;
//! the driver supplies a façade factory (carrying its event sink) and the application does the
//! actual batch via [`SynchronizationService::sync_pull_requests`]. The worker builds a fresh
//! façade on its own thread each tick, so the `!Send` façade never crosses a thread boundary.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use crate::MonicaFacade;

const PR_SYNC_INTERVAL: Duration = Duration::from_secs(10);
const PR_SYNC_BATCH_LIMIT: usize = 3;
const PR_SYNC_FORCED_BATCH_LIMIT: usize = 20;

/// Handle to nudge the scheduler from a command. A forced sync drains a larger batch and announces
/// completion.
pub struct PrSyncWaker(mpsc::SyncSender<bool>);

impl PrSyncWaker {
    pub fn wake_forced(&self) -> bool {
        self.0.try_send(true).is_ok()
    }
}

/// Spawn the PR-sync interval worker. `make_facade` builds a fresh façade (with the driver's event
/// sink) on the worker thread each cycle; it captures only `Send` state (e.g. a Tauri `AppHandle`).
pub fn start_pr_sync<F>(make_facade: F) -> PrSyncWaker
where
    F: Fn() -> anyhow::Result<MonicaFacade> + Send + 'static,
{
    let in_flight = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<bool>(1);
    let spawn_result = std::thread::Builder::new()
        .name("monica-pr-sync".to_string())
        .spawn(move || {
            // A current-thread runtime: the GitHub fetches are awaited serially here, so a single
            // reactor with no worker pool is enough and avoids spinning a second multi-thread pool.
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!(target: "monica_runtime::pr_sync", "failed to build sync runtime: {e}");
                    return;
                }
            };
            loop {
                let forced = match rx.recv_timeout(PR_SYNC_INTERVAL) {
                    Ok(f) => f,
                    Err(mpsc::RecvTimeoutError::Timeout) => false,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if in_flight.swap(true, Ordering::AcqRel) {
                    continue;
                }
                let _guard = InFlightGuard(Arc::clone(&in_flight));
                let limit = if forced { PR_SYNC_FORCED_BATCH_LIMIT } else { PR_SYNC_BATCH_LIMIT };
                // Forced syncs announce completion (so the manual action confirms); the periodic
                // sweep stays quiet to avoid churning the frontend every interval.
                rt.block_on(run_batch(&make_facade, limit, forced));
            }
        });
    if let Err(e) = spawn_result {
        log::error!(target: "monica_runtime::pr_sync", "failed to start PR sync scheduler: {e}");
    }
    PrSyncWaker(tx)
}

struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn run_batch<F>(make_facade: &F, limit: usize, announce: bool)
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
{
    let mut monica = match make_facade() {
        Ok(monica) => monica,
        Err(e) => {
            log::error!(target: "monica_runtime::pr_sync", "failed to open façade for PR sync: {e:#}");
            return;
        }
    };
    if let Err(e) = monica.synchronization().sync_pull_requests(limit, announce).await {
        log::error!(target: "monica_runtime::pr_sync", "PR sync batch failed: {e}");
    }
}
