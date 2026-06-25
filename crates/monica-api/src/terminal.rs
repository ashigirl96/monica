use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Detached,
    Exited,
    Lost,
    Failed,
}

impl From<monica_application::TerminalSessionStatus> for TerminalSessionStatus {
    fn from(value: monica_application::TerminalSessionStatus) -> Self {
        match value {
            monica_application::TerminalSessionStatus::Starting => Self::Starting,
            monica_application::TerminalSessionStatus::Running => Self::Running,
            monica_application::TerminalSessionStatus::Detached => Self::Detached,
            monica_application::TerminalSessionStatus::Exited => Self::Exited,
            monica_application::TerminalSessionStatus::Lost => Self::Lost,
            monica_application::TerminalSessionStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionKind {
    Shell,
    Agent,
    Task,
    Scratch,
}

impl From<monica_application::TerminalSessionKind> for TerminalSessionKind {
    fn from(value: monica_application::TerminalSessionKind) -> Self {
        match value {
            monica_application::TerminalSessionKind::Shell => Self::Shell,
            monica_application::TerminalSessionKind::Agent => Self::Agent,
            monica_application::TerminalSessionKind::Task => Self::Task,
            monica_application::TerminalSessionKind::Scratch => Self::Scratch,
        }
    }
}

impl From<TerminalSessionKind> for monica_application::TerminalSessionKind {
    fn from(value: TerminalSessionKind) -> Self {
        match value {
            TerminalSessionKind::Shell => Self::Shell,
            TerminalSessionKind::Agent => Self::Agent,
            TerminalSessionKind::Task => Self::Task,
            TerminalSessionKind::Scratch => Self::Scratch,
        }
    }
}

// jscpd:ignore-start — this DTO intentionally mirrors `monica_domain::TerminalSession` field-for-field;
// the From impl below keeps them in lockstep. The duplication is the contract boundary, not copy-paste drift.
/// A durable shell/agent process session owned by the PTY daemon. UI tabs attach to and
/// detach from sessions; only an explicit terminate kills the underlying process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct TerminalSession {
    pub id: String,
    pub runspace_id: Option<String>,
    /// The Workbench tab this session was created for. Burned into the child env as
    /// MONICA_TERMINAL_TAB_ID, so reattach prefers reusing it to keep hook claims valid.
    pub tab_id: Option<String>,
    pub kind: TerminalSessionKind,
    pub cwd: String,
    pub shell: String,
    pub status: TerminalSessionStatus,
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
    pub transcript_path: Option<String>,
    pub exit_code: Option<i32>,
    pub started_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub exited_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
// jscpd:ignore-end

impl From<monica_application::TerminalSession> for TerminalSession {
    fn from(value: monica_application::TerminalSession) -> Self {
        Self {
            id: value.id,
            runspace_id: value.runspace_id,
            tab_id: value.tab_id,
            kind: value.kind.into(),
            cwd: value.cwd,
            shell: value.shell,
            status: value.status.into(),
            pid: value.pid,
            rows: value.rows,
            cols: value.cols,
            transcript_path: value.transcript_path,
            exit_code: value.exit_code,
            started_at: value.started_at,
            last_seen_at: value.last_seen_at,
            exited_at: value.exited_at,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TerminalTabRow {
    pub id: String,
    pub cwd: String,
    pub title: String,
    #[specta(type = specta_typescript::Number)]
    pub sort_order: i64,
    pub terminal_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TerminalRunspaceRow {
    pub id: String,
    #[specta(type = specta_typescript::Number)]
    pub sort_order: i64,
    pub tabs: Vec<TerminalTabRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TerminalStateSnapshot {
    pub runspaces: Vec<TerminalRunspaceRow>,
}
