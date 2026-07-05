use anyhow::Result;

use monica_domain::{ClaudeSession, NewClaudeSession};

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
    /// Reserve the mapping row (status `pending`). Fails if the referenced terminal
    /// session row does not exist (the mapping must never point at nothing) or if the id
    /// is already reserved — the primary key is the idempotency lock.
    fn create_claude_session(&mut self, new: NewClaudeSession) -> Result<ClaudeSession>;

    /// Confirm the launch write: pending → active. `false` means the row left `pending`
    /// (the PTY settled first and the coupled transition ended it) — the open failed.
    fn mark_claude_session_launched(&mut self, claude_session_id: &str) -> Result<bool>;

    /// Remove a reservation whose launch never happened, freeing the id for a clean retry.
    fn delete_claude_session(&mut self, claude_session_id: &str) -> Result<()>;

    fn get_claude_session(&self, claude_session_id: &str) -> Result<Option<ClaudeSession>>;

    fn list_claude_sessions(&self) -> Result<Vec<ClaudeSession>>;
}
