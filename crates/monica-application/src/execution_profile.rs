use serde::{Deserialize, Serialize};

use monica_domain::Agent;

/// Claude Code permission mode. Execution-specific, not a domain concept.
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
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum PermissionMode {
    Default,
    Plan,
    AcceptEdits,
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionProfile {
    pub worktree_root: Option<String>,
    pub setup_timeout_sec: i64,
    pub agent_default: Agent,
    pub agent_permission_mode: PermissionMode,
    pub hooks_claude: bool,
}

impl Default for ExecutionProfile {
    fn default() -> Self {
        Self {
            worktree_root: None,
            setup_timeout_sec: 600,
            agent_default: Agent::Claude,
            agent_permission_mode: PermissionMode::Plan,
            hooks_claude: true,
        }
    }
}
