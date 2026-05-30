use std::str::FromStr;

use anyhow::{anyhow, Result};
use rusqlite::Row;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Inbox,
    Ready,
    InProgress,
    Done,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Inbox => "inbox",
            TaskStatus::Ready => "ready",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Done => "done",
        }
    }

    /// Parse a status the way a CLI user types it: dashes are accepted in place of the stored
    /// snake_case underscores, so `in-progress` resolves to [`TaskStatus::InProgress`]. Kept in
    /// core so the CLI and any future GUI share one acceptance rule.
    pub fn parse_token(s: &str) -> Result<Self> {
        s.replace('-', "_").parse()
    }
}

impl FromStr for TaskStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "inbox" => TaskStatus::Inbox,
            "ready" => TaskStatus::Ready,
            "in_progress" => TaskStatus::InProgress,
            "done" => TaskStatus::Done,
            other => return Err(anyhow!("unknown task status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    SettingUp,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
}

impl TaskRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskRunStatus::SettingUp => "setting_up",
            TaskRunStatus::Running => "running",
            TaskRunStatus::WaitingForUser => "waiting_for_user",
            TaskRunStatus::Stopped => "stopped",
            TaskRunStatus::Failed => "failed",
        }
    }
}

impl FromStr for TaskRunStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "setting_up" => TaskRunStatus::SettingUp,
            "running" => TaskRunStatus::Running,
            "waiting_for_user" => TaskRunStatus::WaitingForUser,
            "stopped" => TaskRunStatus::Stopped,
            "failed" => TaskRunStatus::Failed,
            other => return Err(anyhow!("unknown task run status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunWaitReason {
    AskUserQuestion,
    ExitPlanMode,
}

impl TaskRunWaitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskRunWaitReason::AskUserQuestion => "ask_user_question",
            TaskRunWaitReason::ExitPlanMode => "exit_plan_mode",
        }
    }
}

impl FromStr for TaskRunWaitReason {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "ask_user_question" => TaskRunWaitReason::AskUserQuestion,
            "exit_plan_mode" => TaskRunWaitReason::ExitPlanMode,
            other => return Err(anyhow!("unknown task run wait reason: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayStatus {
    Inbox,
    Ready,
    InProgress,
    SettingUp,
    Running,
    WaitingForUser,
    Stopped,
    Failed,
    Done,
}

impl DisplayStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DisplayStatus::Inbox => "inbox",
            DisplayStatus::Ready => "ready",
            DisplayStatus::InProgress => "in_progress",
            DisplayStatus::SettingUp => "setting_up",
            DisplayStatus::Running => "running",
            DisplayStatus::WaitingForUser => "waiting_for_user",
            DisplayStatus::Stopped => "stopped",
            DisplayStatus::Failed => "failed",
            DisplayStatus::Done => "done",
        }
    }

    pub fn parse_token(s: &str) -> Result<Self> {
        s.replace('-', "_").parse()
    }

    pub fn from_task_and_run(task: TaskStatus, run: Option<TaskRunStatus>) -> Self {
        match task {
            TaskStatus::Inbox => DisplayStatus::Inbox,
            TaskStatus::Ready => DisplayStatus::Ready,
            TaskStatus::InProgress => match run {
                Some(TaskRunStatus::SettingUp) => DisplayStatus::SettingUp,
                Some(TaskRunStatus::Running) => DisplayStatus::Running,
                Some(TaskRunStatus::WaitingForUser) => DisplayStatus::WaitingForUser,
                Some(TaskRunStatus::Stopped) => DisplayStatus::Stopped,
                Some(TaskRunStatus::Failed) => DisplayStatus::Failed,
                None => DisplayStatus::InProgress,
            },
            TaskStatus::Done => DisplayStatus::Done,
        }
    }
}

impl FromStr for DisplayStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "inbox" => DisplayStatus::Inbox,
            "ready" => DisplayStatus::Ready,
            "in_progress" => DisplayStatus::InProgress,
            "setting_up" => DisplayStatus::SettingUp,
            "running" => DisplayStatus::Running,
            "waiting_for_user" => DisplayStatus::WaitingForUser,
            "stopped" => DisplayStatus::Stopped,
            "failed" => DisplayStatus::Failed,
            "done" => DisplayStatus::Done,
            other => return Err(anyhow!("unknown display status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Development,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskKind::Development => "development",
        }
    }
}

impl FromStr for TaskKind {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "development" => TaskKind::Development,
            other => return Err(anyhow!("unknown task kind: {other}")),
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
pub struct Task {
    pub id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub phase: Option<String>,
    pub title: String,
    pub body: String,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: Value,
    pub source: Option<Value>,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Task {
    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let labels: String = row.get("labels")?;
        let details: String = row.get("details_json")?;
        let source: Option<String> = row.get("source_json")?;
        let kind: String = row.get("kind")?;
        let status: String = row.get("status")?;
        Ok(Task {
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
            deleted_at: row.get("deleted_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSummaryRow {
    pub id: String,
    pub project: Option<String>,
    pub github_issue_number: Option<i64>,
    pub task_status: TaskStatus,
    pub task_run_status: Option<TaskRunStatus>,
    pub task_run_wait_reason: Option<TaskRunWaitReason>,
    pub status: DisplayStatus,
    pub branch: Option<String>,
}

/// Input for inserting a [`Task`]. The `id` and timestamps are assigned by the store.
#[derive(Debug, Clone)]
pub struct NewTask {
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub title: String,
    pub body: String,
    pub phase: Option<String>,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub details: Value,
    pub source: Option<Value>,
}

impl NewTask {
    pub fn new(kind: TaskKind, title: impl Into<String>) -> Self {
        Self {
            kind,
            status: TaskStatus::Inbox,
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

/// An execution attempt against a [`Task`]. Persisted from issue E onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub agent: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub status: TaskRunStatus,
    pub wait_reason: Option<TaskRunWaitReason>,
    pub settings_path: Option<String>,
    pub provider_session_id: Option<String>,
    pub last_event_name: Option<String>,
    pub last_event_at: Option<String>,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}

/// A provider/hook observation applied to an existing [`TaskRun`].
#[derive(Debug, Clone, Copy)]
pub struct TaskRunObservation<'a> {
    pub status: Option<TaskRunStatus>,
    pub wait_reason: Option<Option<TaskRunWaitReason>>,
    pub event_name: Option<&'a str>,
    pub at: &'a str,
    pub provider_session_id: Option<&'a str>,
    pub metadata: Option<&'a Value>,
}

impl TaskRun {
    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let status: String = row.get("status")?;
        let wait_reason: Option<String> = row.get("wait_reason")?;
        let metadata: String = row.get("metadata_json")?;
        Ok(TaskRun {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            agent: row.get("agent")?,
            branch: row.get("branch")?,
            worktree_path: row.get("worktree_path")?,
            status: status.parse()?,
            wait_reason: wait_reason.map(|s| s.parse()).transpose()?,
            settings_path: row.get("settings_path")?,
            provider_session_id: row.get("provider_session_id")?,
            last_event_name: row.get("last_event_name")?,
            last_event_at: row.get("last_event_at")?,
            metadata: serde_json::from_str(&metadata)?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

/// Input for starting a task run. The `id`, status, and timestamps are assigned by the store:
/// [`crate::Db::start_task_run`] always inserts at [`TaskRunStatus::SettingUp`].
#[derive(Debug, Clone)]
pub struct NewTaskRun {
    pub task_id: String,
    pub agent: Option<Agent>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
}

/// A status/hook event recorded against a task or run. Persisted from issue G onward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub kind: String,
    pub payload: Value,
    pub created_at: String,
}

impl Event {
    pub(crate) fn from_row(row: &Row) -> Result<Self> {
        let payload: String = row.get("payload_json")?;
        Ok(Event {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            task_run_id: row.get("task_run_id")?,
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
    pub task_id: String,
    pub ref_type: RefType,
    pub repo: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub created_at: String,
}

impl ExternalRef {
    pub fn new(
        task_id: impl Into<String>,
        ref_type: RefType,
        repo: Option<String>,
        number: Option<i64>,
        url: Option<String>,
    ) -> Self {
        Self {
            id: 0,
            task_id: task_id.into(),
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
            task_id: row.get("task_id")?,
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
