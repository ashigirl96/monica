//! A connection's queue of frames for its writer thread, and the depths that decide when a
//! session's live output stops and when catch-up from the transcript starts and stops.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Arc;

use tania_terminal_protocol::{to_frame, ServerMessage};

/// macOS hands out at most 1024 bytes per PTY read, so a 200 KB burst is 200+ frames and a
/// Shell that stalls for a few hundred ms is enough to fill the queue.
const CAPACITY: usize = 256;
/// Live output stops here, leaving 32 frames for responses and Exit.
const LIVE_LIMIT: usize = 224;
/// Below `LIVE_LIMIT`, so the connection's other sessions stay live while one catches up.
const CATCH_UP_CEILING: usize = 192;
/// Well below `CATCH_UP_CEILING`, so each catch-up refills the queue in one batch rather than a
/// frame at a time.
const CATCH_UP_LOW_WATER: usize = 64;

/// SeqCst throughout: the writer decrements `queued` then reads `behind`, fanout sets `behind`
/// then reads `queued`, and only a single total order guarantees one of them sees the other.
#[derive(Default)]
struct Backlog {
    queued: AtomicUsize,
    behind: AtomicBool,
}

/// Sending half of a connection's queue. Nothing here blocks: a full queue means the peer
/// stopped reading, and the caller decides what that means for the frame.
#[derive(Clone)]
pub struct Outbox {
    tx: SyncSender<String>,
    backlog: Arc<Backlog>,
}

/// The writer thread's half of a connection's queue.
pub struct OutboxReceiver {
    rx: Receiver<String>,
    backlog: Arc<Backlog>,
}

pub fn outbox() -> (Outbox, OutboxReceiver) {
    let (tx, rx) = std::sync::mpsc::sync_channel(CAPACITY);
    let backlog = Arc::<Backlog>::default();
    let outbox = Outbox {
        tx,
        backlog: Arc::clone(&backlog),
    };
    (outbox, OutboxReceiver { rx, backlog })
}

impl Outbox {
    /// Nothing drains the count of an outbox built on a bare channel, so its live output stops
    /// after `LIVE_LIMIT` frames however fast the test reads.
    #[cfg(test)]
    pub(super) fn unmetered(tx: SyncSender<String>) -> Self {
        Self {
            tx,
            backlog: Arc::default(),
        }
    }

    /// Serialize and enqueue; false when the queue is full or the writer is gone.
    pub fn send(&self, msg: &ServerMessage) -> bool {
        let line = match to_frame(msg) {
            Ok(line) => line,
            Err(e) => {
                log::error!("failed to serialize server message: {e}");
                return false;
            }
        };
        // Counted before enqueueing so the writer's decrement for this frame cannot come first.
        self.backlog.queued.fetch_add(1, Ordering::SeqCst);
        let sent = self.tx.try_send(line).is_ok();
        if !sent {
            self.backlog.queued.fetch_sub(1, Ordering::SeqCst);
        }
        sent
    }

    pub fn send_live(&self, msg: &ServerMessage) -> bool {
        self.queued() < LIVE_LIMIT && self.send(msg)
    }

    pub fn has_room_to_catch_up(&self) -> bool {
        self.queued() < CATCH_UP_CEILING
    }

    pub fn set_behind(&self, behind: bool) {
        self.backlog.behind.store(behind, Ordering::SeqCst);
    }

    /// True when the writer may already have taken its last chance to see `set_behind(true)`.
    pub fn drained(&self) -> bool {
        self.queued() <= CATCH_UP_LOW_WATER
    }

    fn queued(&self) -> usize {
        self.backlog.queued.load(Ordering::SeqCst)
    }
}

impl OutboxReceiver {
    pub fn recv(&self) -> Option<String> {
        let line = self.rx.recv().ok()?;
        self.backlog.queued.fetch_sub(1, Ordering::SeqCst);
        Some(line)
    }

    pub fn catch_up_due(&self) -> bool {
        self.backlog.queued.load(Ordering::SeqCst) <= CATCH_UP_LOW_WATER
            && self.backlog.behind.load(Ordering::SeqCst)
    }
}
