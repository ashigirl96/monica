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

impl From<monica_domain::TerminalSessionStatus> for TerminalSessionStatus {
    fn from(value: monica_domain::TerminalSessionStatus) -> Self {
        match value {
            monica_domain::TerminalSessionStatus::Starting => Self::Starting,
            monica_domain::TerminalSessionStatus::Running => Self::Running,
            monica_domain::TerminalSessionStatus::Detached => Self::Detached,
            monica_domain::TerminalSessionStatus::Exited => Self::Exited,
            monica_domain::TerminalSessionStatus::Lost => Self::Lost,
            monica_domain::TerminalSessionStatus::Failed => Self::Failed,
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

impl From<monica_domain::TerminalSessionKind> for TerminalSessionKind {
    fn from(value: monica_domain::TerminalSessionKind) -> Self {
        match value {
            monica_domain::TerminalSessionKind::Shell => Self::Shell,
            monica_domain::TerminalSessionKind::Agent => Self::Agent,
            monica_domain::TerminalSessionKind::Task => Self::Task,
            monica_domain::TerminalSessionKind::Scratch => Self::Scratch,
        }
    }
}

impl From<TerminalSessionKind> for monica_domain::TerminalSessionKind {
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

impl From<monica_domain::TerminalSession> for TerminalSession {
    fn from(value: monica_domain::TerminalSession) -> Self {
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

// The workbench layout is owned by the application (`TerminalStateSnapshot`) but crosses the Tauri
// boundary as this DTO. The two shapes are intentionally identical; these conversions keep them in
// lockstep so commands map with `.into()` instead of hand-rolling field copies.
impl From<monica_application::TerminalStateSnapshot> for TerminalStateSnapshot {
    fn from(value: monica_application::TerminalStateSnapshot) -> Self {
        Self {
            runspaces: value.runspaces.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<monica_application::TerminalRunspaceRow> for TerminalRunspaceRow {
    fn from(value: monica_application::TerminalRunspaceRow) -> Self {
        Self {
            id: value.id,
            sort_order: value.sort_order,
            tabs: value.tabs.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<monica_application::TerminalTabRow> for TerminalTabRow {
    fn from(value: monica_application::TerminalTabRow) -> Self {
        Self {
            id: value.id,
            cwd: value.cwd,
            title: value.title,
            sort_order: value.sort_order,
            terminal_session_id: value.terminal_session_id,
        }
    }
}

impl From<TerminalStateSnapshot> for monica_application::TerminalStateSnapshot {
    fn from(value: TerminalStateSnapshot) -> Self {
        Self {
            runspaces: value.runspaces.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TerminalRunspaceRow> for monica_application::TerminalRunspaceRow {
    fn from(value: TerminalRunspaceRow) -> Self {
        Self {
            id: value.id,
            sort_order: value.sort_order,
            tabs: value.tabs.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TerminalTabRow> for monica_application::TerminalTabRow {
    fn from(value: TerminalTabRow) -> Self {
        Self {
            id: value.id,
            cwd: value.cwd,
            title: value.title,
            sort_order: value.sort_order,
            terminal_session_id: value.terminal_session_id,
        }
    }
}
