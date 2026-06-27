use monica_domain::{Agent, PermissionMode};

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
