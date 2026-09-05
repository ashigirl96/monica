//! The GitHub-sync worker. Owns the wake channel; the driver supplies a façade factory (carrying its
//! event sink) and the application does the actual refresh via
//! [`SynchronizationService::force_sync_github`]. The worker builds a fresh façade on its
//! own thread for each wake, so the `!Send` façade never crosses a thread boundary. There is no
//! periodic schedule: syncs run only when a command wakes the worker.

use std::sync::mpsc;

use crate::MonicaFacade;

/// Handle to wake the sync worker from a command.
pub struct GithubSyncWaker(mpsc::SyncSender<()>);

impl GithubSyncWaker {
    /// Request a sync. Returns false only when the worker is gone (thread spawn failed or it
    /// exited); a full channel means a wake is already queued, which covers this request too.
    pub fn wake_forced(&self) -> bool {
        !matches!(self.0.try_send(()), Err(mpsc::TrySendError::Disconnected(_)))
    }
}

/// Spawn the GitHub-sync worker. `make_facade` builds a fresh façade (with the driver's event sink)
/// on the worker thread each wake; it captures only `Send` state (e.g. a Tauri `AppHandle`).
pub fn start_github_sync<F>(make_facade: F) -> GithubSyncWaker
where
    F: Fn() -> anyhow::Result<MonicaFacade> + Send + 'static,
{
    // Capacity 1: a wake arriving while a sync runs is queued and coalesces with any later ones,
    // so a burst of requests yields at most one trailing sync.
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let spawn_result = std::thread::Builder::new()
        .name("monica-github-sync".to_string())
        .spawn(move || {
            // A current-thread runtime: the GitHub fetches are awaited serially here, so a single
            // reactor with no worker pool is enough and avoids spinning a second multi-thread pool.
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!(target: "monica_runtime::github_sync", "failed to build sync runtime: {e}");
                    return;
                }
            };
            // Blocks until a command wakes us; ends when every waker is dropped.
            while rx.recv().is_ok() {
                rt.block_on(run_sync(&make_facade));
            }
        });
    if let Err(e) = spawn_result {
        log::error!(target: "monica_runtime::github_sync", "failed to start GitHub sync worker: {e}");
    }
    GithubSyncWaker(tx)
}

async fn run_sync<F>(make_facade: &F)
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
{
    let mut monica = match make_facade() {
        Ok(monica) => monica,
        Err(e) => {
            log::error!(target: "monica_runtime::github_sync", "failed to open façade for GitHub sync: {e:#}");
            return;
        }
    };
    if let Err(e) = monica.synchronization().force_sync_github().await {
        log::error!(target: "monica_runtime::github_sync", "GitHub sync failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::start_github_sync;

    #[test]
    fn wake_forced_stays_true_while_the_worker_lives_even_when_a_wake_is_queued() {
        let waker = start_github_sync(|| Err(anyhow::anyhow!("no facade in this test")));
        // Burst faster than the worker drains: some sends land on a full channel, which must
        // read as "a sync is already pending", not as a dead worker.
        for _ in 0..32 {
            assert!(waker.wake_forced());
        }
    }
}
