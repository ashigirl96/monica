use anyhow::Result;

use monica_domain::{
    AgentSessionStatus, NewTerminalSession, ProviderSessionEvent, TaskRunWaitReason,
    TerminalSession, TerminalSessionStatus,
};

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

    /// Set the hook-observed agent state driving the per-tab indicator. `provider_event` lets the
    /// store atomically enforce explicit starts and one-shot resume handoffs; unrelated provider
    /// evidence is ignored. Returns `true` only when status/reason changed; provider-only claims
    /// and missing rows return `false`.
    fn set_terminal_session_agent_status(
        &self,
        id: &str,
        agent_status: Option<AgentSessionStatus>,
        agent_wait_reason: Option<TaskRunWaitReason>,
        provider_session_id: Option<&str>,
        provider_event: ProviderSessionEvent,
    ) -> Result<bool>;

    /// Clear agent state only when the ending hook still owns this terminal session. A late
    /// SessionEnd from an older provider must not clear a newer provider's state.
    fn clear_terminal_session_agent_status(
        &self,
        id: &str,
        provider_session_id: Option<&str>,
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
