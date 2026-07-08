use serde::{Deserialize, Serialize};

use crate::status::TaskRunWaitReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeSessionStatus {
    Pending,
    Active,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeConversationStatus {
    Idle,
    Thinking,
    AwaitingUser,
}

impl From<monica_domain::ClaudeConversationStatus> for ClaudeConversationStatus {
    fn from(value: monica_domain::ClaudeConversationStatus) -> Self {
        match value {
            monica_domain::ClaudeConversationStatus::Idle => Self::Idle,
            monica_domain::ClaudeConversationStatus::Thinking => Self::Thinking,
            monica_domain::ClaudeConversationStatus::AwaitingUser => Self::AwaitingUser,
        }
    }
}

impl From<monica_domain::ClaudeSessionStatus> for ClaudeSessionStatus {
    fn from(value: monica_domain::ClaudeSessionStatus) -> Self {
        match value {
            monica_domain::ClaudeSessionStatus::Pending => Self::Pending,
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
    pub conversation_status: ClaudeConversationStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
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
            conversation_status: value.conversation_status.into(),
            wait_reason: value.wait_reason.map(TaskRunWaitReason::from),
            created_at: value.created_at,
            ended_at: value.ended_at,
        }
    }
}

/// One transcript record surfaced to the frontend (assistant text / tool uses).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ClaudeTranscriptRecordKind {
    Assistant {
        text: String,
        tool_uses: Vec<ClaudeToolUse>,
    },
    User,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ClaudeToolUse {
    pub id: String,
    pub name: String,
    pub input_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ClaudeTranscriptRecord {
    pub uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(flatten)]
    pub kind: ClaudeTranscriptRecordKind,
}

impl From<monica_application::ClaudeTranscriptRecord> for ClaudeTranscriptRecord {
    fn from(value: monica_application::ClaudeTranscriptRecord) -> Self {
        Self {
            uuid: value.uuid,
            timestamp: value.timestamp,
            kind: match value.kind {
                monica_application::ClaudeTranscriptRecordKind::Assistant { text, tool_uses } => {
                    ClaudeTranscriptRecordKind::Assistant {
                        text,
                        tool_uses: tool_uses
                            .into_iter()
                            .map(|tool_use| ClaudeToolUse {
                                id: tool_use.id,
                                name: tool_use.name,
                                input_json: tool_use.input_json,
                            })
                            .collect(),
                    }
                }
                monica_application::ClaudeTranscriptRecordKind::User => {
                    ClaudeTranscriptRecordKind::User
                }
                monica_application::ClaudeTranscriptRecordKind::Other => {
                    ClaudeTranscriptRecordKind::Other
                }
            },
        }
    }
}
