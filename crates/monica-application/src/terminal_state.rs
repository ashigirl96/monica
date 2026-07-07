//! Persisted workbench layout — the runspaces/tabs the desktop restores on launch. A read/write
//! projection (like `TaskSummaryRow`), owned by the application so the `TerminalSessionRepository`
//! port and the Tauri DTO can both name it without either side depending on the other.

#[derive(Debug, Clone)]
pub struct TerminalTabRow {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub sort_order: i64,
    pub terminal_session_id: Option<String>,
}

/// Classification of a runspace by what populates it. Never persisted: the `agent-runtime`
/// runspace is materialized frontend-side and round-trips through save/load, so a stored kind
/// could go stale — deriving it from the id here keeps the id convention out of the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalRunspaceKind {
    Standard,
    AgentRuntime,
}

impl TerminalRunspaceKind {
    pub fn of_runspace_id(id: &str) -> Self {
        if id == crate::claude_runtime::agent_runtime_runspace_id() {
            Self::AgentRuntime
        } else {
            Self::Standard
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalRunspaceRow {
    pub id: String,
    pub kind: TerminalRunspaceKind,
    pub sort_order: i64,
    pub tabs: Vec<TerminalTabRow>,
}

#[derive(Debug, Clone)]
pub struct TerminalStateSnapshot {
    pub runspaces: Vec<TerminalRunspaceRow>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_runtime_id_classifies_as_agent_runtime() {
        assert_eq!(
            TerminalRunspaceKind::of_runspace_id("agent-runtime"),
            TerminalRunspaceKind::AgentRuntime
        );
    }

    #[test]
    fn other_ids_classify_as_standard() {
        for id in ["bench-task-1", "ws-abc", "", "agent-runtime-2"] {
            assert_eq!(
                TerminalRunspaceKind::of_runspace_id(id),
                TerminalRunspaceKind::Standard
            );
        }
    }
}
