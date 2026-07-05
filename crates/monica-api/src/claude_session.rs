use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeSessionStatus {
    Active,
    Ended,
}

impl From<monica_domain::ClaudeSessionStatus> for ClaudeSessionStatus {
    fn from(value: monica_domain::ClaudeSessionStatus) -> Self {
        match value {
            monica_domain::ClaudeSessionStatus::Active => Self::Active,
            monica_domain::ClaudeSessionStatus::Ended => Self::Ended,
        }
    }
}

/// The durable mapping for a Claude Code session Monica launched: which Workbench
/// runspace/tab hosts it, which terminal session drives its PTY, and the cwd its JSONL
/// transcript path derives from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ClaudeSession {
    pub claude_session_id: String,
    pub runspace_id: String,
    pub tab_id: String,
    pub terminal_session_id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub status: ClaudeSessionStatus,
    pub created_at: String,
    pub ended_at: Option<String>,
}

impl From<monica_domain::ClaudeSession> for ClaudeSession {
    fn from(value: monica_domain::ClaudeSession) -> Self {
        Self {
            claude_session_id: value.claude_session_id,
            runspace_id: value.runspace_id,
            tab_id: value.tab_id,
            terminal_session_id: value.terminal_session_id,
            cwd: value.cwd,
            name: value.name,
            status: value.status.into(),
            created_at: value.created_at,
            ended_at: value.ended_at,
        }
    }
}
