//! Persisted workbench layout — the runspaces/tabs the desktop restores on launch. A read/write
//! projection (like `TaskSummaryRow`), owned by the application so the `TerminalSessionRepository`
//! port and the Tauri DTO can both name it without either side depending on the other.

use monica_domain::RunspaceId;

#[derive(Debug, Clone)]
pub struct TerminalTabRow {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub sort_order: i64,
    pub terminal_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TerminalRunspaceRow {
    pub id: RunspaceId,
    pub sort_order: i64,
    pub pinned_tab_id: Option<String>,
    pub tabs: Vec<TerminalTabRow>,
}

#[derive(Debug, Clone)]
pub struct TerminalStateSnapshot {
    pub runspaces: Vec<TerminalRunspaceRow>,
}
