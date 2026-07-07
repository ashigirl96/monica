//! Drains the `claude_session_events` outbox into UI events. The hook that writes those
//! rows runs in a short-lived `monica hook` process whose EventSink is a no-op, so the
//! desktop is the one that must read the transcript JSONL and emit
//! `ClaudeSessionStateChanged` / `ClaudeSessionMessages` — this worker gives it a
//! heartbeat, same shape as `notification_drain` (dedicated thread + waker + in-flight
//! guard; the façade is `!Send`, so each tick opens its own).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

use crate::{InFlightGuard, MonicaFacade};

const DRAIN_INTERVAL: Duration = Duration::from_millis(750);
const DRAIN_BATCH_LIMIT: usize = 50;
const SWEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a completed turn whose transcript had nothing new keeps being re-polled.
/// Claude flushes the assistant record around the Stop hook, occasionally after it; past
/// this window the persisted offset catches it up on the next completed turn instead.
const RECHECK_WINDOW: Duration = Duration::from_secs(3);

pub struct ClaudeSessionDrainHandle(#[allow(dead_code)] mpsc::SyncSender<()>);

pub fn start_claude_session_drain<F>(make_facade: F, home: PathBuf) -> ClaudeSessionDrainHandle
where
    F: Fn() -> anyhow::Result<MonicaFacade> + Send + 'static,
{
    let in_flight = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let spawn_result = std::thread::Builder::new()
        .name("monica-claude-session-drain".to_string())
        .spawn(move || {
            let mut rechecks: HashMap<String, Instant> = HashMap::new();
            let mut last_sweep: Option<Instant> = None;
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
                if last_sweep.is_none_or(|t| t.elapsed() >= SWEEP_INTERVAL) {
                    sweep_tick(&make_facade);
                    last_sweep = Some(Instant::now());
                }
                drain_tick(&make_facade, &home, &mut rechecks);
            }
        });
    if let Err(e) = spawn_result {
        log::error!(
            target: "monica_runtime::claude_session_drain",
            "failed to start claude session drain: {e}"
        );
    }
    ClaudeSessionDrainHandle(tx)
}

fn drain_tick<F>(make_facade: &F, home: &std::path::Path, rechecks: &mut HashMap<String, Instant>)
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
{
    let mut monica = match make_facade() {
        Ok(m) => m,
        Err(e) => {
            log::error!(
                target: "monica_runtime::claude_session_drain",
                "failed to open façade: {e:#}"
            );
            return;
        }
    };
    match monica.executions().drain_claude_session_events(home, DRAIN_BATCH_LIMIT) {
        Ok(outcome) => {
            let now = Instant::now();
            for claude_session_id in outcome.recheck {
                rechecks.entry(claude_session_id).or_insert(now);
            }
        }
        Err(e) => {
            log::error!(
                target: "monica_runtime::claude_session_drain",
                "failed to drain claude session events: {e:#}"
            );
            return;
        }
    }
    rechecks.retain(|claude_session_id, since| {
        if since.elapsed() > RECHECK_WINDOW {
            return false;
        }
        match monica.executions().poll_claude_session_transcript(home, claude_session_id) {
            // Emitted something — the flush landed; stop re-polling.
            Ok(true) => false,
            Ok(false) => true,
            Err(e) => {
                log::warn!(
                    target: "monica_runtime::claude_session_drain",
                    "failed to re-poll transcript for {claude_session_id}: {e:#}"
                );
                false
            }
        }
    });
}

fn sweep_tick<F>(make_facade: &F)
where
    F: Fn() -> anyhow::Result<MonicaFacade>,
{
    let mut monica = match make_facade() {
        Ok(m) => m,
        Err(e) => {
            log::error!(
                target: "monica_runtime::claude_session_drain",
                "failed to open façade for sweep: {e:#}"
            );
            return;
        }
    };
    if let Err(e) = monica.executions().sweep_claude_session_events() {
        log::error!(
            target: "monica_runtime::claude_session_drain",
            "failed to sweep claude session events: {e:#}"
        );
    }
}
