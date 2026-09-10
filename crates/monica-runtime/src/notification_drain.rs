//! The notification drain, and the one worker in Monica that ticks fast enough for a stuck
//! dependency to bury the log. It wakes every two seconds, so a fault that persists is a fault
//! that repeats forty-three thousand times a day; every failure here goes through a [`TickLog`]
//! rather than straight to the logger.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use monica_domain::NotificationIntent;

use crate::tick_log::TickLog;
use crate::MonicaFacade;

const DRAIN_INTERVAL: Duration = Duration::from_secs(2);
const DRAIN_BATCH_LIMIT: usize = 10;
/// Roughly half an hour at [`DRAIN_INTERVAL`]: often enough that a wedged drain is still visible,
/// rare enough that a whole day of it costs a handful of lines.
const DRAIN_HEARTBEAT_TICKS: u32 = 900;

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
        .spawn(move || {
            let mut tick = TickLog::with_heartbeat(DRAIN_HEARTBEAT_TICKS);
            loop {
                match rx.recv_timeout(DRAIN_INTERVAL) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(()) => {}
                }
                if in_flight.swap(true, Ordering::AcqRel) {
                    continue;
                }
                let _guard = InFlightGuard(Arc::clone(&in_flight));
                report(&mut tick, drain_batch(&make_facade, &deliver));
            }
        });
    if let Err(e) = spawn_result {
        log::error!(
            target: "monica_runtime::notification_drain",
            "failed to start notification drain: {e}"
        );
    }
    NotificationDrainHandle(tx)
}

struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// What one tick found wrong. `summary` is the dedup key, so it deliberately excludes the intent
/// ids that shift from tick to tick; `detail` carries those and is only ever printed on a line
/// that survives deduplication. `level` is the one it is printed at when it does.
struct DrainFault {
    summary: String,
    detail: String,
    level: log::Level,
}

fn report(tick: &mut TickLog, fault: Option<DrainFault>) {
    let Some(fault) = fault else {
        if let Some(suppressed) = tick.clear() {
            log::info!(
                target: "monica_runtime::notification_drain",
                "notification drain recovered suppressed={suppressed}"
            );
        }
        return;
    };
    match tick.observe(&fault.summary) {
        Some(suppressed) => log::log!(
            target: "monica_runtime::notification_drain",
            fault.level,
            "{} suppressed={suppressed}",
            fault.detail
        ),
        None => log::debug!(target: "monica_runtime::notification_drain", "{}", fault.detail),
    }
}

fn drain_batch<F, D>(make_facade: &F, deliver: &D) -> Option<DrainFault>
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
    D: Fn(&NotificationIntent) -> Result<(), String>,
{
    // Both of these leave the drain unable to do anything at all until someone fixes them.
    let mut monica = match make_facade() {
        Ok(m) => m,
        Err(e) => {
            return Some(DrainFault {
                summary: format!("open: {e:#}"),
                detail: format!("failed to open façade error={e:#}"),
                level: log::Level::Error,
            })
        }
    };
    let pending = match monica.notifications().list_pending(DRAIN_BATCH_LIMIT) {
        Ok(p) => p,
        Err(e) => {
            return Some(DrainFault {
                summary: format!("list: {e}"),
                detail: format!("failed to list pending notifications error={e}"),
                level: log::Level::Error,
            })
        }
    };
    // A `deliver` failure is the normal path for a notification the OS refused: it is recorded via
    // `mark_failed` and is not a fault of the drain. Only a store write that fails is, because the
    // same intents then come back on the next tick and every tick after it.
    let mut mark_errors: Vec<(i64, String)> = Vec::new();
    for intent in &pending {
        let marked = match deliver(intent) {
            Ok(()) => monica.notifications().mark_delivered(intent.id),
            Err(err) => monica.notifications().mark_failed(intent.id, &err),
        };
        if let Err(e) = marked {
            mark_errors.push((intent.id, e.to_string()));
        }
    }
    mark_fault(&mark_errors)
}

/// Keyed on the count and the first error rather than on the intent ids: a batch stuck on the same
/// write failure must dedup, while a change in how much is failing is worth hearing about. Stays a
/// warning because the notification itself was delivered — only the bookkeeping of that failed.
fn mark_fault(errors: &[(i64, String)]) -> Option<DrainFault> {
    let (_, first) = errors.first()?;
    let ids: Vec<String> = errors.iter().map(|(id, _)| id.to_string()).collect();
    Some(DrainFault {
        summary: format!("mark: count={} {first}", errors.len()),
        detail: format!(
            "failed to record notification delivery count={} ids={} error={first}",
            errors.len(),
            ids.join(",")
        ),
        level: log::Level::Warn,
    })
}

#[cfg(test)]
mod tests {
    use super::{mark_fault, report, DrainFault};
    use crate::tick_log::TickLog;

    fn a_fault() -> Option<DrainFault> {
        Some(DrainFault {
            summary: "mark: count=1 boom".into(),
            detail: "d".into(),
            level: log::Level::Warn,
        })
    }

    #[test]
    fn a_clean_batch_produces_no_fault() {
        assert!(mark_fault(&[]).is_none());
    }

    #[test]
    fn the_dedup_key_excludes_the_intent_ids() {
        // The same stuck write reaches different intents as the queue shifts; that must not read
        // as a new fault, or the two-second loop escapes deduplication entirely.
        let a = mark_fault(&[(1, "database is locked".into()), (2, "database is locked".into())]);
        let b = mark_fault(&[(7, "database is locked".into()), (9, "database is locked".into())]);
        assert_eq!(a.as_ref().map(|f| &f.summary), b.as_ref().map(|f| &f.summary));
        assert_ne!(a.as_ref().map(|f| &f.detail), b.as_ref().map(|f| &f.detail));
    }

    #[test]
    fn a_different_failure_count_is_a_different_fault() {
        let one = mark_fault(&[(1, "disk full".into())]).unwrap();
        let two = mark_fault(&[(1, "disk full".into()), (2, "disk full".into())]).unwrap();
        assert_ne!(one.summary, two.summary);
    }

    #[test]
    fn the_detail_names_every_failing_intent() {
        let fault = mark_fault(&[(3, "boom".into()), (4, "boom".into())]).unwrap();
        assert!(fault.detail.contains("ids=3,4"), "{}", fault.detail);
        assert!(fault.detail.contains("count=2"), "{}", fault.detail);
    }

    /// The regression that motivated aggregating faults at all: a persistent write failure used to
    /// log once per intent per tick, which is ten lines every two seconds.
    #[test]
    fn a_persistent_mark_failure_stops_being_loud() {
        let mut tick = TickLog::with_heartbeat(0);
        let summary = || mark_fault(&[(1, "database is locked".into())]).unwrap().summary;
        assert_eq!(tick.observe(&summary()), Some(0));
        for _ in 0..100 {
            assert_eq!(tick.observe(&summary()), None);
        }
    }

    /// `report` must not clear the history on a tick that failed, or the fault would read as new
    /// on every single tick and never dedup.
    #[test]
    fn a_faulted_tick_keeps_its_history() {
        let mut tick = TickLog::with_heartbeat(0);
        report(&mut tick, a_fault());
        report(&mut tick, a_fault());
        // Still faulted, so the run is live and `clear` has something to report.
        assert_eq!(tick.clear(), Some(1));
    }

    #[test]
    fn a_clean_tick_after_a_fault_ends_the_run() {
        let mut tick = TickLog::with_heartbeat(0);
        report(&mut tick, a_fault());
        report(&mut tick, None);
        assert_eq!(tick.clear(), None);
    }
}
