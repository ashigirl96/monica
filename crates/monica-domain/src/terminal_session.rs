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

/// The lifecycle evidence accompanying a provider session id observed in a terminal hook.
/// Resume starts are special: Claude reports the source id first and, for a fork, reports the new
/// id on the first prompt. The store persists that one-shot handoff instead of letting arbitrary
/// prompt events replace the current owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSessionEvent {
    Observed,
    Started,
    ResumeStarted,
    PromptSubmitted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSessionBinding {
    pub provider_session_id: Option<String>,
    pub handoff_from: Option<String>,
}

impl ProviderSessionEvent {
    /// Reconcile hook evidence with the terminal's current provider owner. `None` rejects stale or
    /// ownerless evidence. A matching prompt deliberately keeps a pending resume handoff alive: a
    /// resumed session keeps the same id, while a fork reveals its replacement id on that prompt.
    pub fn reconcile(
        self,
        current_provider: Option<&str>,
        handoff_from: Option<&str>,
        observed_provider: Option<&str>,
    ) -> Option<ProviderSessionBinding> {
        let observed_provider = observed_provider.filter(|id| !id.trim().is_empty());
        let binding = |provider_session_id: Option<&str>, handoff_from: Option<&str>| {
            ProviderSessionBinding {
                provider_session_id: provider_session_id.map(str::to_string),
                handoff_from: handoff_from.map(str::to_string),
            }
        };

        match self {
            ProviderSessionEvent::Started => {
                observed_provider.map(|provider| binding(Some(provider), None))
            }
            ProviderSessionEvent::ResumeStarted => observed_provider
                .map(|provider| binding(Some(provider), Some(provider))),
            ProviderSessionEvent::PromptSubmitted => match (current_provider, observed_provider) {
                (Some(current), Some(observed)) if current == observed => {
                    Some(binding(Some(current), handoff_from))
                }
                (Some(current), Some(observed)) if handoff_from == Some(current) => {
                    Some(binding(Some(observed), None))
                }
                (None, None) => Some(binding(None, None)),
                _ => None,
            },
            ProviderSessionEvent::Observed => match (current_provider, observed_provider) {
                (Some(current), Some(observed)) if current == observed => {
                    Some(binding(Some(current), None))
                }
                (None, None) => Some(binding(None, None)),
                _ => None,
            },
        }
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
    /// The provider session currently proven to own this terminal. Session starts establish it;
    /// matching lifecycle events retain it; SessionEnd clears it.
    pub provider_session_id: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::{ProviderSessionBinding, ProviderSessionEvent};

    fn binding(provider: Option<&str>, handoff: Option<&str>) -> ProviderSessionBinding {
        ProviderSessionBinding {
            provider_session_id: provider.map(str::to_string),
            handoff_from: handoff.map(str::to_string),
        }
    }

    #[test]
    fn stale_prompts_cannot_replace_an_active_provider() {
        assert_eq!(
            ProviderSessionEvent::PromptSubmitted.reconcile(
                Some("provider-new"),
                None,
                Some("provider-old")
            ),
            None
        );
    }

    #[test]
    fn resume_handoff_allows_exactly_one_new_prompt_owner() {
        let pending = ProviderSessionEvent::ResumeStarted
            .reconcile(Some("provider-old"), None, Some("provider-source"))
            .unwrap();
        assert_eq!(
            pending,
            binding(Some("provider-source"), Some("provider-source"))
        );

        let same_provider_prompt = ProviderSessionEvent::PromptSubmitted
            .reconcile(
                pending.provider_session_id.as_deref(),
                pending.handoff_from.as_deref(),
                Some("provider-source"),
            )
            .unwrap();
        assert_eq!(same_provider_prompt, pending);

        let completed = ProviderSessionEvent::PromptSubmitted
            .reconcile(
                pending.provider_session_id.as_deref(),
                pending.handoff_from.as_deref(),
                Some("provider-new"),
            )
            .unwrap();
        assert_eq!(completed, binding(Some("provider-new"), None));
        assert_eq!(
            ProviderSessionEvent::PromptSubmitted.reconcile(
                completed.provider_session_id.as_deref(),
                completed.handoff_from.as_deref(),
                Some("provider-late")
            ),
            None
        );
    }
}
