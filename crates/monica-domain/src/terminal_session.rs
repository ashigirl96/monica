use serde::{Deserialize, Serialize};

use crate::status::TaskRunWaitReason;

/// Hook-observed state of the agent running inside a session. Powers the per-tab indicator, so it
/// is deliberately coarser than the TaskRun state machine: no pending-stop guard, no session
/// claiming. Absent on the session row = no agent has reported (or its session ended).
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
pub enum AgentSessionStatus {
    Running,
    WaitingForUser,
}

impl AgentSessionStatus {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// Effect of a hook signal on the session-level agent indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSessionEffect {
    Keep,
    Clear,
    Set(AgentSessionStatus, Option<TaskRunWaitReason>),
}

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
        self.into()
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
pub enum TerminalSessionKind {
    Shell,
    Agent,
    Task,
    Scratch,
}

impl TerminalSessionKind {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// A durable shell/agent process session owned by the PTY daemon. UI tabs attach to and
/// detach from sessions; only an explicit terminate kills the underlying process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    pub agent_status: Option<AgentSessionStatus>,
    pub agent_wait_reason: Option<TaskRunWaitReason>,
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
