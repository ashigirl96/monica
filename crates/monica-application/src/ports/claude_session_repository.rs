use anyhow::Result;

use monica_domain::{ClaudeSession, NewClaudeSession};

/// Persistence for the Claude session mapping (`claude_session_id` ↔ runspace/tab ↔
/// terminal session ↔ cwd). Two invariants are the adapter's to uphold, not the caller's:
///
/// - `create_claude_session` derives the initial status from the referenced terminal
///   session's row *inside one statement* — a session whose terminal row is already
///   settled is inserted as `ended`, never `active`. This closes the race where the PTY
///   exits between the launch write and this insert.
/// - Whenever a terminal session transitions into a terminal status (via
///   `apply_terminal_session_updates`), the mapping rows pointing at it flip to `ended`
///   in the same transaction, stamping `ended_at` once.
pub trait ClaudeSessionRepository {
    /// Insert the mapping row. Fails if the referenced terminal session row does not
    /// exist (the mapping must never point at nothing).
    fn create_claude_session(&mut self, new: NewClaudeSession) -> Result<ClaudeSession>;

    fn get_claude_session(&self, claude_session_id: &str) -> Result<Option<ClaudeSession>>;

    fn list_claude_sessions(&self) -> Result<Vec<ClaudeSession>>;
}
