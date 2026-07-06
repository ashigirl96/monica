use serde::{Deserialize, Serialize};

use crate::status::TaskRunWaitReason;

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
    /// marks an open interrupted mid-flight; [`ClaudeLaunchPhase`] records how far that
    /// open got, which decides whether a stale row can be reclaimed automatically.
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

/// How far a pending open got, stamped durably at each step so a crash leaves evidence.
/// Only meaningful while `status` is `pending`.
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
pub enum ClaudeLaunchPhase {
    /// The reservation exists but no launch write was attempted yet (the `submitting`
    /// stamp precedes any write): provably nothing runs under this id, so a stale row
    /// in this phase is safe to free automatically.
    Reserved,
    /// A launch write was attempted; whether it landed is unknowable if the open died
    /// here, so a stale row in this phase is reclaimed only through observed death of
    /// its terminal session.
    Submitting,
}

impl ClaudeLaunchPhase {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// Where the conversation inside a live session stands, driven by hook signals.
/// Orthogonal to [`ClaudeSessionStatus`], which is the lifecycle of the mapping itself:
/// a session whose PTY died is `ended` regardless of what the conversation last did.
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
pub enum ClaudeConversationStatus {
    /// Claude is waiting for a prompt (session started, or the last turn completed).
    Idle,
    /// A turn is in flight.
    Thinking,
    /// Claude is blocked on the user: a pending question, a plan approval, or a
    /// permission prompt.
    AwaitingUser,
}

impl ClaudeConversationStatus {
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
    pub launch_phase: ClaudeLaunchPhase,
    pub conversation_status: ClaudeConversationStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
    /// The session id Claude itself currently writes its transcript under. Starts equal to
    /// `claude_session_id`; a `/clear` or resume moves Claude onto a new id, and the hook
    /// re-stamps this so the JSONL path keeps pointing at the live file.
    pub provider_session_id: Option<String>,
    /// Byte offset up to which the transcript JSONL has been consumed. Reset to 0 when
    /// `provider_session_id` changes (the transcript is a different file from then on).
    pub jsonl_offset: u64,
    pub created_at: String,
    pub ended_at: Option<String>,
}

impl ClaudeSession {
    /// The session id the transcript JSONL is currently keyed by.
    pub fn transcript_session_id(&self) -> &str {
        self.provider_session_id
            .as_deref()
            .unwrap_or(&self.claude_session_id)
    }
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
