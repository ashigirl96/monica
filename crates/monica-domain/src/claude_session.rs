use serde::{Deserialize, Serialize};

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ClaudeSessionStatus {
    /// Reserved before the launch command is submitted into the PTY. A row stuck here
    /// marks an open interrupted mid-flight: whether Claude actually launched is
    /// unknowable, so the id is never resolved or reused automatically.
    Pending,
    /// The launch write was acknowledged by the daemon — Claude runs (or ran) under
    /// this id.
    Active,
    Ended,
}

impl ClaudeSessionStatus {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// The durable mapping for a Claude Code session Monica launched: which Workbench
/// runspace/tab hosts it, which terminal session drives its PTY, and the cwd its JSONL
/// transcript path derives from. `claude_session_id` is the pre-minted UUID Claude runs
/// under (`claude --session-id <uuid>`) — no separate id is issued.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// Input for reserving a mapping row before the launch is submitted. Status and
/// timestamps are assigned by the store, which derives the initial status from the
/// referenced terminal session's state (`pending`, or `ended` if it already settled).
#[derive(Debug, Clone)]
pub struct NewClaudeSession {
    pub claude_session_id: String,
    pub runspace_id: String,
    pub tab_id: String,
    pub terminal_session_id: String,
    pub cwd: String,
    pub name: Option<String>,
}
