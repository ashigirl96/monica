//! Drains the `claude_session_events` outbox into UI events. The hook that writes those
//! rows runs in a short-lived `monica hook` process whose EventSink is a no-op, so the
//! desktop is the one that must read the transcript JSONL and emit
//! `ClaudeSessionStateChanged` / `ClaudeSessionMessages` — this worker gives it a
//! heartbeat (dedicated thread + waker + in-flight guard; the façade is `!Send`, so each
//! iteration opens its own).
//!
//! Two signals drive the loop. The 750ms tick consumes the outbox (the state path); a
//! [`ClaudeSessionDrainHandle::wake_transcript`] from the transcript watcher polls that
//! session's JSONL immediately (the data path). Both paths read on this one thread, so
//! the `jsonl_offset` cursor has a single writer and events reach subscribers in emit
//! order.
//!
//! A watched turn that settled into Idle/Ended before its response was fully consumed
//! has its state snapshot withheld by the drain (`deferred_states`); this worker
//! releases it — never before the messages — via the transcript tail: a consumed
//! transcript ending on an assistant record has delivered its response (mid-turn
//! assistant records are always followed by a tool_result user record), one ending
//! elsewhere still owes it, and the next watch wakeup (or [`STATE_FLUSH_DEADLINE`], for
//! turns with no assistant output at all) resolves it. Sessions no one watches release
//! immediately — there is no subscriber stream to order against.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

use monica_application::{ClaudeSessionDrainOutcome, TranscriptPoll};

use crate::transcript_watch::SessionWatchRegistry;
use crate::{InFlightGuard, MonicaFacade};

const DRAIN_INTERVAL: Duration = Duration::from_millis(750);
const DRAIN_BATCH_LIMIT: usize = 50;
const SWEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a withheld state snapshot may wait for the assistant flush before it is
/// released regardless (a turn interrupted before any output would otherwise never
/// report Idle).
const STATE_FLUSH_DEADLINE: Duration = Duration::from_secs(2);
/// Watch wakeups queued ahead of the loop; a burst beyond this is dropped safely — the
/// next append or the turn's own drain re-polls from the persisted cursor.
const SIGNAL_BUFFER: usize = 64;

#[derive(Clone)]
pub struct ClaudeSessionDrainHandle(mpsc::SyncSender<String>);

impl ClaudeSessionDrainHandle {
    /// Ask the worker to poll this session's transcript now. Fire-and-forget from the
    /// watcher's thread; a full queue is fine (see [`SIGNAL_BUFFER`]).
    pub fn wake_transcript(&self, claude_session_id: &str) {
        let _ = self.0.try_send(claude_session_id.to_string());
    }
}

/// The façade calls one loop iteration makes, behind a seam so the release logic in
/// [`DeferredStates`] is testable without a database.
trait DrainOps {
    fn drain_events(&mut self, limit: usize) -> anyhow::Result<ClaudeSessionDrainOutcome>;
    fn poll_transcript(&mut self, claude_session_id: &str) -> anyhow::Result<TranscriptPoll>;
    fn emit_state(&mut self, claude_session_id: &str) -> anyhow::Result<()>;
}

struct FacadeOps<'a> {
    monica: &'a mut MonicaFacade,
    home: &'a std::path::Path,
}

impl DrainOps for FacadeOps<'_> {
    fn drain_events(&mut self, limit: usize) -> anyhow::Result<ClaudeSessionDrainOutcome> {
        Ok(self.monica.executions().drain_claude_session_events(self.home, limit)?)
    }

    fn poll_transcript(&mut self, claude_session_id: &str) -> anyhow::Result<TranscriptPoll> {
        Ok(self
            .monica
            .executions()
            .poll_claude_session_transcript(self.home, claude_session_id)?)
    }

    fn emit_state(&mut self, claude_session_id: &str) -> anyhow::Result<()> {
        Ok(self.monica.executions().emit_claude_session_state(claude_session_id)?)
    }
}

/// State snapshots withheld until their turn's assistant output has been delivered.
struct DeferredStates {
    watched: SessionWatchRegistry,
    /// Withheld sessions and when their deferral started (the release deadline anchor).
    pending: HashMap<String, Instant>,
    /// Whether the last transcript record consumed for a session was an assistant
    /// record — the "response delivered" signal (see the module docs). Fed by both the
    /// wakeup polls and the drain's own reads, and pruned to the watched/pending set.
    tail_is_assistant: HashMap<String, bool>,
}

impl DeferredStates {
    fn new(watched: SessionWatchRegistry) -> Self {
        Self { watched, pending: HashMap::new(), tail_is_assistant: HashMap::new() }
    }

    /// A watch wakeup: poll the session's transcript, and release its withheld state if
    /// the response has now been fully consumed.
    fn handle_transcript(&mut self, ops: &mut impl DrainOps, claude_session_id: &str) {
        let poll = match ops.poll_transcript(claude_session_id) {
            Ok(poll) => poll,
            Err(e) => {
                log::warn!(
                    target: "monica_runtime::claude_session_drain",
                    "failed to poll transcript for {claude_session_id}: {e:#}"
                );
                return;
            }
        };
        if let Some(tail) = poll.tail_is_assistant {
            self.tail_is_assistant.insert(claude_session_id.to_string(), tail);
        }
        if self.pending.contains_key(claude_session_id)
            && self.tail_is_assistant.get(claude_session_id) == Some(&true)
        {
            self.release(ops, claude_session_id);
        }
    }

    /// Fold one outbox drain outcome in: withheld sessions whose response was already
    /// streamed (or that no watcher covers) release immediately, the rest wait for the
    /// next wakeup or the deadline. A state the drain did emit supersedes any deferral.
    fn handle_drain_outcome(
        &mut self,
        ops: &mut impl DrainOps,
        outcome: ClaudeSessionDrainOutcome,
        now: Instant,
    ) {
        // The drain's own reads count toward the consumed tail too — the cache means
        // "the last record consumed by anyone", or a previous turn's leftover assistant
        // tail would release a new turn's withheld Idle early.
        for (claude_session_id, poll) in outcome.transcript_polls {
            if let Some(tail) = poll.tail_is_assistant {
                self.tail_is_assistant.insert(claude_session_id, tail);
            }
        }
        for claude_session_id in outcome.states_emitted {
            self.pending.remove(&claude_session_id);
        }
        for claude_session_id in outcome.deferred_states {
            let streamed = self.tail_is_assistant.get(&claude_session_id) == Some(&true);
            if streamed || !self.watched.is_watched(&claude_session_id) {
                self.release(ops, &claude_session_id);
            } else {
                self.pending.insert(claude_session_id, now);
            }
        }
    }

    /// Release every withheld state older than [`STATE_FLUSH_DEADLINE`], polling the
    /// transcript first so a missed wakeup still delivers the messages before the state.
    fn flush_expired(&mut self, ops: &mut impl DrainOps, now: Instant) {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, since)| now.duration_since(**since) >= STATE_FLUSH_DEADLINE)
            .map(|(id, _)| id.clone())
            .collect();
        for claude_session_id in expired {
            self.handle_transcript(ops, &claude_session_id);
            if self.pending.contains_key(&claude_session_id) {
                self.release(ops, &claude_session_id);
            }
        }
    }

    /// Drop tail entries no deferral or watcher can ever read again, so the map tracks
    /// the live subscription set instead of every session the process has seen.
    fn prune_tails(&mut self) {
        let pending = &self.pending;
        let watched = &self.watched;
        self.tail_is_assistant
            .retain(|claude_session_id, _| {
                pending.contains_key(claude_session_id) || watched.is_watched(claude_session_id)
            });
    }

    fn release(&mut self, ops: &mut impl DrainOps, claude_session_id: &str) {
        if let Err(e) = ops.emit_state(claude_session_id) {
            log::warn!(
                target: "monica_runtime::claude_session_drain",
                "failed to emit the deferred state for {claude_session_id}: {e:#}"
            );
        }
        self.pending.remove(claude_session_id);
    }
}

pub fn start_claude_session_drain<F>(
    make_facade: F,
    home: PathBuf,
    watched: SessionWatchRegistry,
) -> ClaudeSessionDrainHandle
where
    F: Fn() -> anyhow::Result<MonicaFacade> + Send + 'static,
{
    let in_flight = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<String>(SIGNAL_BUFFER);
    let spawn_result = std::thread::Builder::new()
        .name("monica-claude-session-drain".to_string())
        .spawn(move || {
            let mut deferred = DeferredStates::new(watched);
            let mut last_sweep: Option<Instant> = None;
            let mut next_drain = Instant::now() + DRAIN_INTERVAL;
            loop {
                let wait = next_drain.saturating_duration_since(Instant::now());
                let first = match rx.recv_timeout(wait) {
                    Ok(claude_session_id) => Some(claude_session_id),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if in_flight.swap(true, Ordering::AcqRel) {
                    continue;
                }
                let _guard = InFlightGuard(Arc::clone(&in_flight));
                // Coalesce the queued wakeups: polling a session once covers every
                // append signalled so far (the read starts at the persisted cursor).
                let mut transcripts: HashSet<String> = HashSet::new();
                transcripts.extend(first);
                while let Ok(claude_session_id) = rx.try_recv() {
                    transcripts.insert(claude_session_id);
                }
                let mut monica = match make_facade() {
                    Ok(m) => m,
                    Err(e) => {
                        log::error!(
                            target: "monica_runtime::claude_session_drain",
                            "failed to open façade: {e:#}"
                        );
                        continue;
                    }
                };
                let mut ops = FacadeOps { monica: &mut monica, home: &home };
                for claude_session_id in &transcripts {
                    deferred.handle_transcript(&mut ops, claude_session_id);
                }
                if Instant::now() >= next_drain {
                    match ops.drain_events(DRAIN_BATCH_LIMIT) {
                        Ok(outcome) => {
                            deferred.handle_drain_outcome(&mut ops, outcome, Instant::now())
                        }
                        Err(e) => log::error!(
                            target: "monica_runtime::claude_session_drain",
                            "failed to drain claude session events: {e:#}"
                        ),
                    }
                    next_drain = Instant::now() + DRAIN_INTERVAL;
                }
                deferred.flush_expired(&mut ops, Instant::now());
                deferred.prune_tails();
                if last_sweep.is_none_or(|t| t.elapsed() >= SWEEP_INTERVAL) {
                    sweep_tick(&mut monica);
                    last_sweep = Some(Instant::now());
                }
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

fn sweep_tick(monica: &mut MonicaFacade) {
    if let Err(e) = monica.executions().sweep_claude_session_events() {
        log::error!(
            target: "monica_runtime::claude_session_drain",
            "failed to sweep claude session events: {e:#}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Debug, PartialEq)]
    enum Call {
        Poll(String),
        Emit(String),
    }

    #[derive(Default)]
    struct FakeOps {
        polls: RefCell<HashMap<String, TranscriptPoll>>,
        calls: RefCell<Vec<Call>>,
    }

    impl FakeOps {
        fn prime_poll(&self, id: &str, tail: Option<bool>) {
            self.polls
                .borrow_mut()
                .insert(id.to_string(), TranscriptPoll { tail_is_assistant: tail });
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.take()
        }
    }

    impl DrainOps for &FakeOps {
        fn drain_events(&mut self, _limit: usize) -> anyhow::Result<ClaudeSessionDrainOutcome> {
            unreachable!("these tests feed outcomes directly")
        }

        fn poll_transcript(&mut self, id: &str) -> anyhow::Result<TranscriptPoll> {
            self.calls.borrow_mut().push(Call::Poll(id.to_string()));
            Ok(self.polls.borrow().get(id).copied().unwrap_or_default())
        }

        fn emit_state(&mut self, id: &str) -> anyhow::Result<()> {
            self.calls.borrow_mut().push(Call::Emit(id.to_string()));
            Ok(())
        }
    }

    /// A DeferredStates whose registry marks `watched_ids` as streamed by a subscriber.
    fn deferred_watching(watched_ids: &[&str]) -> (DeferredStates, Vec<crate::transcript_watch::WatchRetainGuard>) {
        let registry = SessionWatchRegistry::default();
        let handle = crate::transcript_watch::transcript_watch_with_backend(
            std::env::temp_dir().join(format!(
                "monica-draintest-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            )),
            registry.clone(),
            |_| {},
            |_| Ok(Box::new(NoopBackend)),
        )
        .unwrap();
        let guards =
            watched_ids.iter().map(|id| handle.retain(id, "/w/drain-test")).collect();
        (DeferredStates::new(registry), guards)
    }

    struct NoopBackend;

    impl crate::transcript_watch::WatchBackend for NoopBackend {
        fn watch_dir(&mut self, _dir: &std::path::Path) -> anyhow::Result<()> {
            Ok(())
        }

        fn unwatch_dir(&mut self, _dir: &std::path::Path) {}
    }

    fn outcome_deferring(id: &str) -> ClaudeSessionDrainOutcome {
        ClaudeSessionDrainOutcome {
            drained: 1,
            transcript_polls: vec![(id.to_string(), TranscriptPoll::default())],
            deferred_states: vec![id.to_string()],
            states_emitted: Vec::new(),
        }
    }

    #[test]
    fn deferred_state_releases_immediately_when_the_tail_is_an_assistant_record() {
        // The watcher streamed the whole turn (final read ended on the assistant record)
        // before the outbox tick — the withheld Idle must not wait for the deadline.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(true));
        deferred.handle_transcript(&mut &ops, "cs-1");
        ops.calls();

        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), Instant::now());

        assert_eq!(ops.calls(), vec![Call::Emit("cs-1".to_string())]);
        assert!(deferred.pending.is_empty());
    }

    #[test]
    fn deferred_state_waits_when_the_tail_is_a_tool_result() {
        // Mid-turn assistant records were streamed but the transcript last ended on a
        // tool_result user record: the final response is still owed, Idle must wait.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");
        ops.calls();

        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), Instant::now());
        assert_eq!(ops.calls(), Vec::new(), "the withheld Idle must not be emitted yet");

        // The late flush arrives: the wakeup polls, sees the assistant tail, releases.
        ops.prime_poll("cs-1", Some(true));
        deferred.handle_transcript(&mut &ops, "cs-1");
        assert_eq!(
            ops.calls(),
            vec![Call::Poll("cs-1".to_string()), Call::Emit("cs-1".to_string())]
        );
        assert!(deferred.pending.is_empty());
    }

    #[test]
    fn a_wakeup_containing_only_a_mid_turn_assistant_does_not_release() {
        // A coalesced read can hold a mid-turn assistant record followed by its
        // tool_result: the response is still owed, whatever the read contained.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");
        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), Instant::now());
        ops.calls();

        // Another append lands: assistant(tool_use) + user(tool_result) — tail is still
        // the tool_result even though an assistant record was consumed.
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");

        assert_eq!(ops.calls(), vec![Call::Poll("cs-1".to_string())]);
        assert!(deferred.pending.contains_key("cs-1"));
    }

    #[test]
    fn unwatched_sessions_release_immediately() {
        // No subscriber holds a watch on this session: there is no stream to order
        // against, so the state goes out as it always did.
        let ops = FakeOps::default();
        let mut deferred = DeferredStates::new(SessionWatchRegistry::default());

        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), Instant::now());

        assert_eq!(ops.calls(), vec![Call::Emit("cs-1".to_string())]);
    }

    #[test]
    fn a_watched_session_with_no_consumed_records_still_defers() {
        // The subscriber is real but nothing has been consumed yet (the transcript file
        // is created lazily, or FSEvents lags): absence of a tail must not be read as
        // "unwatched" — the state waits for the wakeup or the deadline.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);

        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), Instant::now());

        assert_eq!(ops.calls(), Vec::new());
        assert!(deferred.pending.contains_key("cs-1"));
    }

    #[test]
    fn the_deadline_polls_before_releasing() {
        // A lost wakeup must not strand the messages behind the state: the expiry path
        // reads the transcript (emitting anything found) before the snapshot goes out.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");
        let deferred_at = Instant::now();
        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), deferred_at);
        ops.calls();

        deferred.flush_expired(&mut &ops, deferred_at + STATE_FLUSH_DEADLINE);

        assert_eq!(
            ops.calls(),
            vec![Call::Poll("cs-1".to_string()), Call::Emit("cs-1".to_string())]
        );
        assert!(deferred.pending.is_empty());
    }

    #[test]
    fn the_deadline_release_still_orders_messages_first_when_the_flush_landed() {
        // The expiry poll itself finds the assistant tail: handle_transcript releases
        // via the normal path and the follow-up release is not doubled.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");
        let deferred_at = Instant::now();
        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), deferred_at);
        ops.calls();
        ops.prime_poll("cs-1", Some(true));

        deferred.flush_expired(&mut &ops, deferred_at + STATE_FLUSH_DEADLINE);

        assert_eq!(
            ops.calls(),
            vec![Call::Poll("cs-1".to_string()), Call::Emit("cs-1".to_string())]
        );
        assert!(deferred.pending.is_empty());
    }

    #[test]
    fn a_pending_state_not_yet_expired_is_left_alone() {
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");
        let deferred_at = Instant::now();
        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), deferred_at);
        ops.calls();

        deferred.flush_expired(&mut &ops, deferred_at + STATE_FLUSH_DEADLINE / 2);

        assert_eq!(ops.calls(), Vec::new());
        assert!(deferred.pending.contains_key("cs-1"));
    }

    #[test]
    fn the_drains_own_read_updates_the_consumed_tail() {
        // Turn 1 left the cache on an assistant tail. Turn 2's drain read consumed
        // records ending on a tool_result: that read must overwrite the cache, or the
        // stale assistant tail would release turn 2's withheld Idle before its response.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(true));
        deferred.handle_transcript(&mut &ops, "cs-1");
        ops.calls();

        let outcome = ClaudeSessionDrainOutcome {
            drained: 1,
            transcript_polls: vec![(
                "cs-1".to_string(),
                TranscriptPoll { tail_is_assistant: Some(false) },
            )],
            deferred_states: vec!["cs-1".to_string()],
            states_emitted: Vec::new(),
        };
        deferred.handle_drain_outcome(&mut &ops, outcome, Instant::now());

        assert_eq!(ops.calls(), Vec::new(), "the stale assistant tail must not release");
        assert!(deferred.pending.contains_key("cs-1"));
    }

    #[test]
    fn a_state_emitted_by_a_later_drain_supersedes_the_deferral() {
        // A new turn's state landing normally must clear the old deferral, or a stale
        // Idle would be re-broadcast at the deadline — a subscriber reads that as the
        // next turn's completion.
        let ops = FakeOps::default();
        let (mut deferred, _guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(false));
        deferred.handle_transcript(&mut &ops, "cs-1");
        let deferred_at = Instant::now();
        deferred.handle_drain_outcome(&mut &ops, outcome_deferring("cs-1"), deferred_at);
        ops.calls();

        let outcome = ClaudeSessionDrainOutcome {
            drained: 1,
            transcript_polls: Vec::new(),
            deferred_states: Vec::new(),
            states_emitted: vec!["cs-1".to_string()],
        };
        deferred.handle_drain_outcome(&mut &ops, outcome, deferred_at);
        deferred.flush_expired(&mut &ops, deferred_at + STATE_FLUSH_DEADLINE * 2);

        assert_eq!(ops.calls(), Vec::new(), "the superseded deferral must not fire");
        assert!(deferred.pending.is_empty());
    }

    #[test]
    fn tails_of_released_unwatched_sessions_are_pruned() {
        let ops = FakeOps::default();
        let (mut deferred, guards) = deferred_watching(&["cs-1"]);
        ops.prime_poll("cs-1", Some(true));
        deferred.handle_transcript(&mut &ops, "cs-1");
        assert!(deferred.tail_is_assistant.contains_key("cs-1"));

        deferred.prune_tails();
        assert!(deferred.tail_is_assistant.contains_key("cs-1"), "watched tails survive");

        drop(guards);
        deferred.prune_tails();
        assert!(
            deferred.tail_is_assistant.is_empty(),
            "an unwatched, non-pending tail must not accumulate"
        );
    }
}
