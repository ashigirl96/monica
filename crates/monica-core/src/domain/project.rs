use serde::{Deserialize, Serialize};

use super::task_run::Agent;

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
pub enum Provider {
    Github,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// Claude Code permission mode. M0 carries the values the project design uses; Claude also
/// accepts `auto`/`dontAsk`, which can be added later without a schema change.
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

/// A repo's execution-environment definition, resolved by `issue run`. One row per repo,
/// keyed by `owner/repo`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub repo: String,
    pub path: Option<String>,
    pub default_branch: String,
    pub worktree_root: Option<String>,
    pub setup_timeout_sec: i64,
    pub agent_default: Agent,
    pub agent_permission_mode: PermissionMode,
    pub hooks_claude: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Project {
    /// Build a project from `owner/repo` with defaults matching the migration v2 column defaults.
    /// `name` is the repo segment after the last `/`. Timestamps stay empty until the store
    /// fills them via column defaults and reads them back.
    pub fn from_repo(repo: impl Into<String>) -> Self {
        let repo = repo.into();
        // Last non-empty path segment, so a trailing slash ("owner/repo/") still yields "repo".
        let name = repo
            .rsplit('/')
            .find(|seg| !seg.is_empty())
            .unwrap_or(&repo)
            .to_string();
        Self {
            id: repo.clone(),
            name,
            provider: Provider::Github,
            repo,
            path: None,
            default_branch: "main".to_string(),
            worktree_root: None,
            setup_timeout_sec: 600,
            agent_default: Agent::Claude,
            agent_permission_mode: PermissionMode::Plan,
            hooks_claude: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}
