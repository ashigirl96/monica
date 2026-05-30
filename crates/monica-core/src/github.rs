use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use octocrab::Octocrab;
use serde::Deserialize;
use serde_json::json;

use crate::{Db, GithubPullRequest, PullRequestSyncResult};

static GH_AUTH_TOKEN: OnceLock<String> = OnceLock::new();
static GH_AUTH_FAILURE: OnceLock<Mutex<Option<CachedAuthFailure>>> = OnceLock::new();

struct CachedAuthFailure {
    retry_after: Instant,
    message: String,
}

pub async fn sync_next_linked_pull_request(db: &mut Db) -> Result<PullRequestSyncResult> {
    let Some(candidate) = db.next_pull_request_sync_candidate()? else {
        return Ok(PullRequestSyncResult::idle());
    };

    match fetch_linked_pull_requests(&candidate.repo, candidate.issue_number).await {
        Ok(pull_requests) => {
            let count = pull_requests.len();
            db.record_pull_request_sync_success(&candidate, &pull_requests)?;
            Ok(PullRequestSyncResult::synced(candidate.task_id, count))
        }
        Err(e) => {
            let message = format!("{e:#}");
            db.record_pull_request_sync_failure(&candidate, &message)?;
            Ok(PullRequestSyncResult::failed(candidate.task_id, message))
        }
    }
}

async fn fetch_linked_pull_requests(
    repo: &str,
    issue_number: i64,
) -> Result<Vec<GithubPullRequest>> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| anyhow!("invalid GitHub repo: {repo}"))?;
    let token = github_token()?;
    let crab = Octocrab::builder().personal_token(token).build()?;
    let payload = json!({
        "query": LINKED_PULL_REQUESTS_QUERY,
        "variables": {
            "owner": owner,
            "name": name,
            "number": issue_number,
            "first": 20,
        },
    });
    let response: LinkedPullRequestsResponse = crab.graphql(&payload).await.with_context(|| {
        format!("failed to fetch linked pull requests for {repo}#{issue_number}")
    })?;
    linked_pull_requests_from_response(response)
}

fn github_token() -> Result<String> {
    for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return Ok(value.to_string());
            }
        }
    }

    if let Some(token) = GH_AUTH_TOKEN.get() {
        return Ok(token.clone());
    }

    if let Some(message) = cached_auth_failure()? {
        return Err(anyhow!(message));
    }

    let output = Command::new("gh")
        .args(["auth", "token"])
        .output()
        .context("failed to run `gh auth token`; set GH_TOKEN or GITHUB_TOKEN")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        let message = format!(
            "gh auth token failed: {}; run `gh auth login` or set GH_TOKEN/GITHUB_TOKEN",
            if detail.is_empty() {
                "no error output"
            } else {
                detail
            }
        );
        cache_auth_failure(&message)?;
        return Err(anyhow!(message));
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(anyhow!("gh auth token returned an empty token"));
    }
    let _ = GH_AUTH_TOKEN.set(token.clone());
    Ok(token)
}

fn cached_auth_failure() -> Result<Option<String>> {
    let Some(cache) = GH_AUTH_FAILURE.get() else {
        return Ok(None);
    };
    let mut cache = cache
        .lock()
        .map_err(|_| anyhow!("GitHub auth failure cache is poisoned"))?;
    if let Some(failure) = cache.as_ref() {
        if Instant::now() < failure.retry_after {
            return Ok(Some(failure.message.clone()));
        }
    }
    *cache = None;
    Ok(None)
}

fn cache_auth_failure(message: &str) -> Result<()> {
    let cache = GH_AUTH_FAILURE.get_or_init(|| Mutex::new(None));
    let mut cache = cache
        .lock()
        .map_err(|_| anyhow!("GitHub auth failure cache is poisoned"))?;
    *cache = Some(CachedAuthFailure {
        retry_after: Instant::now() + Duration::from_secs(300),
        message: message.to_string(),
    });
    Ok(())
}

fn linked_pull_requests_from_response(
    response: LinkedPullRequestsResponse,
) -> Result<Vec<GithubPullRequest>> {
    let repository = response
        .repository
        .ok_or_else(|| anyhow!("GitHub repository was not found"))?;
    let issue = repository
        .issue
        .ok_or_else(|| anyhow!("GitHub issue was not found"))?;
    let mut pull_requests = Vec::new();
    for node in issue.closed_by_pull_requests_references.nodes {
        let Some(node) = node else {
            continue;
        };
        if node.number <= 0 {
            continue;
        }
        pull_requests.push(GithubPullRequest {
            repo: node.repository.name_with_owner.to_lowercase(),
            number: node.number,
            url: node.url,
        });
    }
    Ok(pull_requests)
}

const LINKED_PULL_REQUESTS_QUERY: &str = r#"
query MonicaLinkedPullRequests($owner: String!, $name: String!, $number: Int!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: $first) {
        nodes {
          number
          url
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedPullRequestsResponse {
    repository: Option<LinkedPullRequestsRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedPullRequestsRepository {
    issue: Option<LinkedPullRequestsIssue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedPullRequestsIssue {
    closed_by_pull_requests_references: PullRequestConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestConnection {
    #[serde(default)]
    nodes: Vec<Option<PullRequestNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestNode {
    number: i64,
    url: String,
    repository: PullRequestRepository,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestRepository {
    name_with_owner: String,
}

#[cfg(test)]
mod tests {
    use super::{linked_pull_requests_from_response, LinkedPullRequestsResponse};

    #[test]
    fn extracts_linked_pull_requests_from_graphql_response() {
        let response: LinkedPullRequestsResponse = serde_json::from_value(serde_json::json!({
            "repository": {
                "issue": {
                    "closedByPullRequestsReferences": {
                        "nodes": [
                            {
                                "number": 99,
                                "url": "https://github.com/O/R/pull/99",
                                "repository": { "nameWithOwner": "O/R" }
                            },
                            null
                        ]
                    }
                }
            }
        }))
        .unwrap();

        let pull_requests = linked_pull_requests_from_response(response).unwrap();
        assert_eq!(pull_requests.len(), 1);
        assert_eq!(pull_requests[0].repo, "o/r");
        assert_eq!(pull_requests[0].number, 99);
        assert_eq!(
            pull_requests[0].url,
            "https://github.com/O/R/pull/99".to_string()
        );
    }
}
