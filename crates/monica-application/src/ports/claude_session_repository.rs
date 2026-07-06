use anyhow::Result;

use monica_domain::{ClaudeConversationStatus, ClaudeSession, NewClaudeSession, TaskRunWaitReason};

/// A decoded hook observation applied to a Claude session mapping. Deliberately narrower
/// than the lifecycle API: a hook may move the conversation state and tombstone on a real
/// session end, but never pending → active — that confirmation belongs to the open flow,
/// whose `mark_claude_session_launched` reads `false` as "the PTY settled first" and
/// retires the id.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClaudeSessionObservation<'a> {
    pub conversation_status: Option<ClaudeConversationStatus>,
    /// `Some(None)` clears the reason, `None` leaves it untouched.
    pub wait_reason: Option<Option<TaskRunWaitReason>>,
    /// The session id the event carried. Latest wins; a change resets `jsonl_offset` to 0
    /// in the same transaction (the transcript is a different file from then on).
    pub provider_session_id: Option<&'a str>,
    /// Flip status to `ended` (guarded, `ended_at` stamped once). Only a real session end
    /// (not a `/clear`) may set this: `ended` is an irreversible tombstone.
    pub mark_ended: bool,
}

/// The outcome of trying to claim a session for one in-flight user message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudePromptClaim {
    /// The session was idle and is now marked thinking; the caller owns the send.
    Claimed,
    /// A message is in flight or the session is waiting on the user.
    Busy(ClaudeConversationStatus),
    /// The session has not proven ready for input: the open is still pending, or no hook
    /// has been observed yet (`provider_session_id` is unset). The row's
    /// `conversation_status` may already read `idle` — that is the column default, not a
    /// hook observation — so it must not be trusted as readiness.
    ///
    /// `active_without_hook_for_secs`: `None` while the open is still pending (covered by
    /// the pending-reservation lease); `Some(age)` when the row is active but no hook has
    /// been observed — the threshold judgment belongs to the facade, not the store.
    Launching { active_without_hook_for_secs: Option<i64> },
    Ended,
    NotFound,
}

/// A row of the `claude_session_events` log/outbox, written by the hook process and
/// drained by the desktop worker.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeSessionEvent {
    pub id: i64,
    pub claude_session_id: String,
    /// Canonical signal kind (`session_started`, `turn_completed`, ...) — never the
    /// provider event name, so the drain stays provider-agnostic.
    pub kind: String,
    pub payload_json: String,
    pub created_at: String,
}

/// Persistence for the Claude session mapping (`claude_session_id` ↔ runspace/tab ↔
/// terminal session ↔ cwd). The row is a reservation first: it must exist *before* the
/// launch it deduplicates reaches the PTY, so a crash or a concurrent open with the same
/// id can never end up launching Claude twice. Two invariants are the adapter's to
/// uphold, not the caller's:
///
/// - `create_claude_session` derives the initial status from the referenced terminal
///   session's row *inside one statement* — `pending` normally, `ended` if the terminal
///   row already settled. This closes the race where the PTY exits around the insert.
/// - Whenever a terminal session transitions into a terminal status (via
///   `apply_terminal_session_updates`), the mapping rows pointing at it flip to `ended`
///   in the same transaction, stamping `ended_at` once.
pub trait ClaudeSessionRepository {
    /// Reserve the mapping row (status `pending`, launch_phase `reserved`). Fails if the
    /// referenced terminal session row does not exist (the mapping must never point at
    /// nothing) or if the id is already reserved — the primary key is the idempotency lock.
    fn create_claude_session(&mut self, new: NewClaudeSession) -> Result<ClaudeSession>;

    /// Stamp that a launch write is about to go out: launch_phase reserved → submitting.
    /// Called BEFORE the write, so a pending row still in `reserved` provably never
    /// received a launch. `false` means the row already left that state.
    fn mark_claude_session_submitting(&mut self, claude_session_id: &str) -> Result<bool>;

    /// Seconds since the row was created, measured by the same clock that stamped it —
    /// distinguishes a stale crash-leftover reservation from an in-flight open. `None`
    /// when the row does not exist.
    fn claude_session_age_seconds(&self, claude_session_id: &str) -> Result<Option<i64>>;

    /// Confirm the launch write: pending → active. `false` means the row left `pending`
    /// (the PTY settled first and the coupled transition ended it) — the open failed.
    fn mark_claude_session_launched(&mut self, claude_session_id: &str) -> Result<bool>;

    /// Remove a reservation, freeing the id for a clean retry. Sound ONLY while the
    /// launch was provably never attempted (launch_phase still `reserved`, or the
    /// submitting stamp itself failed): once a write may have gone out, killing the PTY
    /// does not roll back Claude's external artifacts (the transcript is keyed by this
    /// id), so the id must keep a row — pending or an ended tombstone — that refuses
    /// reuse.
    fn delete_claude_session(&mut self, claude_session_id: &str) -> Result<()>;

    fn get_claude_session(&self, claude_session_id: &str) -> Result<Option<ClaudeSession>>;

    fn list_claude_sessions(&self) -> Result<Vec<ClaudeSession>>;

    /// Record one hook signal atomically: insert the event row and apply the observation
    /// to the mapping in a single transaction. Returns the updated row, or `None` for an
    /// unknown id (nothing is written — a hook from a session Monica never launched).
    fn record_claude_session_signal(
        &mut self,
        claude_session_id: &str,
        kind: &str,
        payload_json: &str,
        observation: ClaudeSessionObservation<'_>,
    ) -> Result<Option<ClaudeSession>>;

    /// Oldest unconsumed event rows, up to `limit`.
    fn list_unconsumed_claude_session_events(&self, limit: usize)
        -> Result<Vec<ClaudeSessionEvent>>;

    fn mark_claude_session_events_consumed(&mut self, ids: &[i64]) -> Result<()>;

    /// Advance the transcript cursor after a successful read.
    fn set_claude_session_jsonl_offset(
        &mut self,
        claude_session_id: &str,
        offset: u64,
    ) -> Result<()>;

    /// Atomically claim the session for one in-flight user message: idle → thinking, in a
    /// single conditional UPDATE so two concurrent senders cannot both win. Requires a
    /// hook to have been observed (`provider_session_id` set) — see
    /// [`ClaudePromptClaim::Launching`].
    fn claim_claude_session_thinking(&mut self, claude_session_id: &str)
        -> Result<ClaudePromptClaim>;

    /// Undo a claim (or optimistically settle after an interrupt): thinking → idle, only
    /// if the row is still thinking — a state a hook moved on is not overwritten. `false`
    /// means nothing changed.
    fn release_claude_session_thinking(&mut self, claude_session_id: &str) -> Result<bool>;
}
