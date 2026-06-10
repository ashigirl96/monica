use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Detached,
    Exited,
    Lost,
    Failed,
}

impl TerminalSessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TerminalSessionStatus::Starting => "starting",
            TerminalSessionStatus::Running => "running",
            TerminalSessionStatus::Detached => "detached",
            TerminalSessionStatus::Exited => "exited",
            TerminalSessionStatus::Lost => "lost",
            TerminalSessionStatus::Failed => "failed",
        }
    }

    /// Whether the session can never transition again (the process is gone for good).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TerminalSessionStatus::Exited
                | TerminalSessionStatus::Lost
                | TerminalSessionStatus::Failed
        )
    }
}

impl FromStr for TerminalSessionStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "starting" => TerminalSessionStatus::Starting,
            "running" => TerminalSessionStatus::Running,
            "detached" => TerminalSessionStatus::Detached,
            "exited" => TerminalSessionStatus::Exited,
            "lost" => TerminalSessionStatus::Lost,
            "failed" => TerminalSessionStatus::Failed,
            other => return Err(anyhow!("unknown terminal session status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionKind {
    Shell,
    Agent,
    Task,
    Scratch,
}

impl TerminalSessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TerminalSessionKind::Shell => "shell",
            TerminalSessionKind::Agent => "agent",
            TerminalSessionKind::Task => "task",
            TerminalSessionKind::Scratch => "scratch",
        }
    }
}

impl FromStr for TerminalSessionKind {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "shell" => TerminalSessionKind::Shell,
            "agent" => TerminalSessionKind::Agent,
            "task" => TerminalSessionKind::Task,
            "scratch" => TerminalSessionKind::Scratch,
            other => return Err(anyhow!("unknown terminal session kind: {other}")),
        })
    }
}

/// A durable shell/agent process session owned by the PTY daemon. UI tabs attach to and
/// detach from sessions; only an explicit terminate kills the underlying process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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

/// Input for creating a session row. The id (`ts-<n>`), status (`starting`), and timestamps
/// are assigned by the store.
#[derive(Debug, Clone)]
pub struct NewTerminalSession {
    pub runspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub kind: TerminalSessionKind,
    pub cwd: String,
    pub shell: String,
    pub rows: u16,
    pub cols: u16,
}
