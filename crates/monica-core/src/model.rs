use std::str::FromStr;

use anyhow::{anyhow, Result};
use rusqlite::Row;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Inbox,
    Ready,
    SettingUp,
    Running,
    NeedApproval,
    Stopped,
    Failed,
    PrOpen,
    Done,
    Archived,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Inbox => "inbox",
            Status::Ready => "ready",
            Status::SettingUp => "setting_up",
            Status::Running => "running",
            Status::NeedApproval => "need_approval",
            Status::Stopped => "stopped",
            Status::Failed => "failed",
            Status::PrOpen => "pr_open",
            Status::Done => "done",
            Status::Archived => "archived",
        }
    }

    /// Parse a status the way a CLI user types it: dashes are accepted in place of the stored
    /// snake_case underscores, so `need-approval` resolves to [`Status::NeedApproval`]. Kept in
    /// core so the CLI and any future GUI share one acceptance rule.
    pub fn parse_token(s: &str) -> Result<Self> {
        s.replace('-', "_").parse()
    }
}

impl FromStr for Status {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "inbox" => Status::Inbox,
            "ready" => Status::Ready,
            "setting_up" => Status::SettingUp,
            "running" => Status::Running,
            "need_approval" => Status::NeedApproval,
            "stopped" => Status::Stopped,
            "failed" => Status::Failed,
            "pr_open" => Status::PrOpen,
            "done" => Status::Done,
            "archived" => Status::Archived,
            other => return Err(anyhow!("unknown work item status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemKind {
    Development,
}

impl WorkItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkItemKind::Development => "development",
        }
    }
}

impl FromStr for WorkItemKind {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "development" => WorkItemKind::Development,
            other => return Err(anyhow!("unknown work item kind: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefType {
    GithubIssue,
    GithubPullRequest,
}

impl RefType {
    pub fn as_str(self) -> &'static str {
        match self {
            RefType::GithubIssue => "github_issue",
            RefType::GithubPullRequest => "github_pull_request",
        }
    }
}

impl FromStr for RefType {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "github_issue" => RefType::GithubIssue,
            "github_pull_request" => RefType::GithubPullRequest,
            other => return Err(anyhow!("unknown external ref type: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Github,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Github => "github",
        }
    }
}

impl FromStr for Provider {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "github" => Provider::Github,
            other => return Err(anyhow!("unknown provider: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Claude,
}

impl Agent {
    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
        }
    }
}

impl FromStr for Agent {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "claude" => Agent::Claude,
            other => return Err(anyhow!("unknown agent: {other}")),
        })
    }
}

/// Claude Code permission mode. M0 carries the values the project design uses; Claude also
/// accepts `auto`/`dontAsk`, which can be added later without a schema change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    Plan,
    AcceptEdits,
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::Plan => "plan",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }
}

impl FromStr for PermissionMode {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "default" => PermissionMode::Default,
            "plan" => PermissionMode::Plan,
            "acceptEdits" => PermissionMode::AcceptEdits,
            "bypassPermissions" => PermissionMode::BypassPermissions,
            other => return Err(anyhow!("unknown permission mode: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkItem {
    pub id: String,
    pub kind: WorkItemKind,
    pub status: Status,
    pub phase: Option<String>,
    pub title: String,
    pub body: String,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: Value,
    pub source: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkItem {
    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let labels: String = row.get("labels")?;
        let details: String = row.get("details_json")?;
        let source: Option<String> = row.get("source_json")?;
        let kind: String = row.get("kind")?;
        let status: String = row.get("status")?;
        Ok(WorkItem {
            id: row.get("id")?,
            kind: kind.parse()?,
            status: status.parse()?,
            phase: row.get("phase")?,
            title: row.get("title")?,
            body: row.get("body")?,
            project_id: row.get("project_id")?,
            labels: serde_json::from_str(&labels)?,
            details: serde_json::from_str(&details)?,
            source: match source {
                Some(s) => Some(serde_json::from_str(&s)?),
                None => None,
            },
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueStatusRow {
    pub id: String,
    pub project: Option<String>,
    pub github_issue_number: Option<i64>,
    pub status: Status,
    pub branch: Option<String>,
}

/// Input for inserting a [`WorkItem`]. The `id` and timestamps are assigned by the store.
#[derive(Debug, Clone)]
pub struct NewWorkItem {
    pub kind: WorkItemKind,
    pub status: Status,
    pub title: String,
    pub body: String,
    pub phase: Option<String>,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: Value,
    pub source: Option<Value>,
}

impl NewWorkItem {
    pub fn new(kind: WorkItemKind, title: impl Into<String>) -> Self {
        Self {
            kind,
            status: Status::Inbox,
            title: title.into(),
            body: String::new(),
            phase: None,
            project_id: None,
            labels: Vec::new(),
            details: Value::Object(serde_json::Map::new()),
            source: None,
        }
    }
}

/// An execution attempt against a [`WorkItem`]. Persisted from issue E onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub work_item_id: String,
    pub agent: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub status: Status,
    pub settings_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Run {
    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let status: String = row.get("status")?;
        Ok(Run {
            id: row.get("id")?,
            work_item_id: row.get("work_item_id")?,
            agent: row.get("agent")?,
            branch: row.get("branch")?,
            worktree_path: row.get("worktree_path")?,
            status: status.parse()?,
            settings_path: row.get("settings_path")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// Input for starting a run attempt. The `id`, status, and timestamps are assigned by the store:
/// [`crate::Db::start_run`] always inserts at [`Status::SettingUp`].
#[derive(Debug, Clone)]
pub struct NewRun {
    pub work_item_id: String,
    pub agent: Option<Agent>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
}

/// A status/hook event recorded against a work item or run. Persisted from issue G onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub work_item_id: Option<String>,
    pub run_id: Option<String>,
    pub kind: String,
    pub payload: Value,
    pub created_at: String,
}

impl Event {
    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let payload: String = row.get("payload_json")?;
        Ok(Event {
            id: row.get("id")?,
            work_item_id: row.get("work_item_id")?,
            run_id: row.get("run_id")?,
            kind: row.get("kind")?,
            payload: serde_json::from_str(&payload)?,
            created_at: row.get("created_at")?,
        })
    }
}

/// A reference to an item living in an external system (e.g. a GitHub issue).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalRef {
    pub id: i64,
    pub work_item_id: String,
    pub ref_type: RefType,
    pub repo: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub created_at: String,
}

impl ExternalRef {
    pub fn new(
        work_item_id: impl Into<String>,
        ref_type: RefType,
        repo: Option<String>,
        number: Option<i64>,
        url: Option<String>,
    ) -> Self {
        Self {
            id: 0,
            work_item_id: work_item_id.into(),
            ref_type,
            repo,
            number,
            url,
            created_at: String::new(),
        }
    }

    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let ref_type: String = row.get("ref_type")?;
        Ok(ExternalRef {
            id: row.get("id")?,
            work_item_id: row.get("work_item_id")?,
            ref_type: ref_type.parse()?,
            repo: row.get("repo")?,
            number: row.get("number")?,
            url: row.get("url")?,
            created_at: row.get("created_at")?,
        })
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
    /// fills them via column defaults and they are read back by [`Project::from_row`].
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

    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let provider: String = row.get("provider")?;
        let agent_default: String = row.get("agent_default")?;
        let agent_permission_mode: String = row.get("agent_permission_mode")?;
        Ok(Project {
            id: row.get("id")?,
            name: row.get("name")?,
            provider: provider.parse()?,
            repo: row.get("repo")?,
            path: row.get("path")?,
            default_branch: row.get("default_branch")?,
            worktree_root: row.get("worktree_root")?,
            setup_timeout_sec: row.get("setup_timeout_sec")?,
            agent_default: agent_default.parse()?,
            agent_permission_mode: agent_permission_mode.parse()?,
            hooks_claude: row.get::<_, i64>("hooks_claude")? != 0,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}
