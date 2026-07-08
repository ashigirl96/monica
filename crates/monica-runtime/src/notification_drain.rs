use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use monica_domain::NotificationIntent;

use crate::{InFlightGuard, MonicaFacade};

const DRAIN_INTERVAL: Duration = Duration::from_secs(2);
const DRAIN_BATCH_LIMIT: usize = 10;

pub struct NotificationDrainHandle(#[allow(dead_code)] mpsc::SyncSender<()>);

pub fn start_notification_drain<F, D>(make_facade: F, deliver: D) -> NotificationDrainHandle
where
    F: Fn() -> anyhow::Result<MonicaFacade> + Send + 'static,
    D: Fn(&NotificationIntent) -> Result<(), String> + Send + 'static,
{
    let in_flight = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let spawn_result = std::thread::Builder::new()
        .name("monica-notification-drain".to_string())
        .spawn(move || loop {
            match rx.recv_timeout(DRAIN_INTERVAL) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(()) => {}
            }
            if in_flight.swap(true, Ordering::AcqRel) {
                continue;
            }
            let _guard = InFlightGuard(Arc::clone(&in_flight));
            drain_batch(&make_facade, &deliver);
        });
    if let Err(e) = spawn_result {
        log::error!(
            target: "monica_runtime::notification_drain",
            "failed to start notification drain: {e}"
        );
    }
    NotificationDrainHandle(tx)
}

fn drain_batch<F, D>(make_facade: &F, deliver: &D)
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
    D: Fn(&NotificationIntent) -> Result<(), String>,
{
    let mut monica = match make_facade() {
        Ok(m) => m,
        Err(e) => {
            log::error!(
                target: "monica_runtime::notification_drain",
                "failed to open façade: {e:#}"
            );
            return;
        }
    };
    let pending = match monica.notifications().list_pending(DRAIN_BATCH_LIMIT) {
        Ok(p) => p,
        Err(e) => {
            log::error!(
                target: "monica_runtime::notification_drain",
                "failed to list pending notifications: {e}"
            );
            return;
        }
    };
    for intent in &pending {
        match deliver(intent) {
            Ok(()) => {
                if let Err(e) = monica.notifications().mark_delivered(intent.id) {
                    log::warn!(
                        target: "monica_runtime::notification_drain",
                        "failed to mark notification {} delivered: {e}",
                        intent.id
                    );
                }
            }
            Err(err) => {
                if let Err(e) = monica.notifications().mark_failed(intent.id, &err) {
                    log::warn!(
                        target: "monica_runtime::notification_drain",
                        "failed to mark notification {} failed: {e}",
                        intent.id
                    );
                }
            }
        }
    }
}
