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
}

impl RefType {
    pub fn as_str(self) -> &'static str {
        match self {
            RefType::GithubIssue => "github_issue",
        }
    }
}

impl FromStr for RefType {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "github_issue" => RefType::GithubIssue,
            other => return Err(anyhow!("unknown external ref type: {other}")),
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
