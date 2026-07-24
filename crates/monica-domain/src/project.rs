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
pub enum Provider {
    Github,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

/// A repo's identity and location, keyed by `owner/repo`. Execution-environment settings
/// (agent, permissions, hooks, worktree layout) live in [`ExecutionProfile`] in the application
/// layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub repo: String,
    pub path: Option<String>,
    pub default_branch: String,
    /// project の primary note（1:1 の書き殴りノート）。lazy 作成は Phase 3 —
    /// Phase 1 では列と読み取りだけを持ち、書き込み経路はまだ無い。
    pub primary_note_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Project {
    /// Build a project from `owner/repo` with defaults matching the migration v2 column defaults.
    /// `name` is the repo segment after the last `/`. Timestamps stay empty until the store
    /// fills them via column defaults and reads them back.
    pub fn from_repo(repo: impl Into<String>) -> Self {
        let repo = repo.into();
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
            primary_note_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}
