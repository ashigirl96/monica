use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

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
}
