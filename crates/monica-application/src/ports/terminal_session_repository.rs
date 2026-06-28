use anyhow::Result;

use monica_domain::{NewTerminalSession, TerminalSession, TerminalSessionStatus};

use crate::terminal_state::TerminalStateSnapshot;
use crate::usecases::terminal::TerminalSessionUpdate;

/// Persistence for terminal sessions and the workbench layout. The desktop is the only writer of
/// `terminal_sessions`; this port lets the application own session creation, status transitions,
/// daemon-reconcile application, and workbench load/save without the driver touching SQLite.
pub trait TerminalSessionRepository {
    fn create_terminal_session(&mut self, new: NewTerminalSession) -> Result<TerminalSession>;

    /// Record a successful daemon spawn (starting → running with the live pid). The adapter
    /// resolves and stamps the transcript path for `id`.
    fn mark_terminal_session_started(&self, id: &str, pid: Option<u32>) -> Result<()>;

    fn update_terminal_session_status(
        &mut self,
        id: &str,
        status: TerminalSessionStatus,
        exit_code: Option<i32>,
    ) -> Result<()>;

    fn get_terminal_session(&self, id: &str) -> Result<Option<TerminalSession>>;

    fn latest_terminal_session_for_tab(&self, tab_id: &str) -> Result<Option<TerminalSession>>;

    fn list_terminal_sessions(&self, runspace_id: Option<&str>) -> Result<Vec<TerminalSession>>;

    /// Apply daemon-reconcile results in one transaction; a settled (terminal) row never returns
    /// to a live status.
    fn apply_terminal_session_updates(&mut self, updates: &[TerminalSessionUpdate]) -> Result<()>;

    fn load_terminal_state(&self, window_label: &str) -> Result<TerminalStateSnapshot>;

    fn save_terminal_state(
        &mut self,
        window_label: &str,
        snapshot: &TerminalStateSnapshot,
    ) -> Result<()>;
}
