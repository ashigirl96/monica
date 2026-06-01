use anyhow::{anyhow, Context, Result};
use octocrab::Octocrab;
use serde::Deserialize;
use serde_json::json;

use crate::github_auth::{is_auth_error, resolve_pr_sync_token};
use crate::{Db, GithubPullRequest, PullRequestSyncResult};

pub async fn sync_next_linked_pull_request(db: &mut Db) -> Result<PullRequestSyncResult> {
    sync_next_linked_pull_request_inner(db, resolve_pr_sync_token()?).await
}

pub(crate) async fn sync_next_linked_pull_request_inner(
    db: &mut Db,
    token: Option<String>,
) -> Result<PullRequestSyncResult> {
    let Some(token) = token else {
        return Ok(PullRequestSyncResult::auth_required());
    };

    if let Some(candidate) = db.next_pull_request_sync_candidate()? {
        return match fetch_linked_pull_requests(&token, &candidate.repo, candidate.issue_number)
            .await
        {
            Ok(pull_requests) => {
                let count = pull_requests.len();
                db.record_pull_request_sync_success(&candidate, &pull_requests)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, count))
            }
            Err(e) if is_auth_error(&e) => Ok(PullRequestSyncResult::auth_required()),
            Err(e) => {
                let message = format!("{e:#}");
                db.record_pull_request_sync_failure(&candidate, &message)?;
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    }

    if let Some(candidate) = db.next_pull_request_status_sync_candidate()? {
        return match fetch_pull_request(&token, &candidate.repo, candidate.number).await {
            Ok(pull_request) => {
                db.record_pull_request_status_sync_success(&candidate, &pull_request)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, 1))
            }
            Err(e) if is_auth_error(&e) => Ok(PullRequestSyncResult::auth_required()),
            Err(e) => {
                let message = format!("{e:#}");
                db.record_pull_request_status_sync_failure(&candidate, &message)?;
                Ok(PullRequestSyncResult::failed(candidate.task_id, message))
            }
        };
    };

    Ok(PullRequestSyncResult::idle())
}

async fn fetch_linked_pull_requests(
    token: &str,
    repo: &str,
    issue_number: i64,
) -> Result<Vec<GithubPullRequest>> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| anyhow!("invalid GitHub repo: {repo}"))?;
    let crab = Octocrab::builder().personal_token(token.to_string()).build()?;
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

async fn fetch_pull_request(token: &str, repo: &str, number: i64) -> Result<GithubPullRequest> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| anyhow!("invalid GitHub repo: {repo}"))?;
    let crab = Octocrab::builder().personal_token(token.to_string()).build()?;
    let payload = json!({
        "query": PULL_REQUEST_QUERY,
        "variables": {
            "owner": owner,
            "name": name,
            "number": number,
        },
    });
    let response: PullRequestResponse = crab
        .graphql(&payload)
        .await
        .with_context(|| format!("failed to fetch pull request {repo}#{number}"))?;
    pull_request_from_response(response)
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
            repo: pull_request_repo(&node),
            number: node.number,
            url: node.url,
            status: pull_request_status(&node.state, node.is_draft),
        });
    }
    Ok(pull_requests)
}

fn pull_request_from_response(response: PullRequestResponse) -> Result<GithubPullRequest> {
    let repository = response
        .repository
        .ok_or_else(|| anyhow!("GitHub repository was not found"))?;
    let node = repository
        .pull_request
        .ok_or_else(|| anyhow!("GitHub pull request was not found"))?;
    if node.number <= 0 {
        return Err(anyhow!("GitHub pull request returned invalid number"));
    }
    Ok(GithubPullRequest {
        repo: pull_request_repo(&node),
        number: node.number,
        url: node.url,
        status: pull_request_status(&node.state, node.is_draft),
    })
}

fn pull_request_repo(node: &PullRequestNode) -> String {
    node.repository.name_with_owner.to_lowercase()
}

fn pull_request_status(state: &str, is_draft: bool) -> String {
    let state = state.to_ascii_lowercase();
    if state == "open" && is_draft {
        "draft".to_string()
    } else {
        state
    }
}

const LINKED_PULL_REQUESTS_QUERY: &str = r#"
query MonicaLinkedPullRequests($owner: String!, $name: String!, $number: Int!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: $first) {
        nodes {
          number
          url
          state
          isDraft
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
}
"#;

const PULL_REQUEST_QUERY: &str = r#"
query MonicaPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      state
      isDraft
      repository {
        nameWithOwner
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
struct PullRequestResponse {
    repository: Option<PullRequestLookupRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestLookupRepository {
    pull_request: Option<PullRequestNode>,
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
    state: String,
    is_draft: bool,
    repository: PullRequestRepository,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestRepository {
    name_with_owner: String,
}

#[cfg(test)]
mod tests {
    use super::{
        linked_pull_requests_from_response, pull_request_from_response, LinkedPullRequestsResponse,
        PullRequestResponse,
    };

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
                                "state": "MERGED",
                                "isDraft": false,
                                "repository": { "nameWithOwner": "O/R" }
                            },
                            {
                                "number": 100,
                                "url": "https://github.com/O/R/pull/100",
                                "state": "OPEN",
                                "isDraft": true,
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
        assert_eq!(pull_requests.len(), 2);
        assert_eq!(pull_requests[0].repo, "o/r");
        assert_eq!(pull_requests[0].number, 99);
        assert_eq!(
            pull_requests[0].url,
            "https://github.com/O/R/pull/99".to_string()
        );
        assert_eq!(pull_requests[0].status, "merged");
        assert_eq!(pull_requests[1].number, 100);
        assert_eq!(pull_requests[1].status, "draft");
    }

    #[test]
    fn extracts_pull_request_from_graphql_response() {
        let response: PullRequestResponse = serde_json::from_value(serde_json::json!({
            "repository": {
                "pullRequest": {
                    "number": 57,
                    "url": "https://github.com/O/R/pull/57",
                    "state": "OPEN",
                    "isDraft": false,
                    "repository": { "nameWithOwner": "O/R" }
                }
            }
        }))
        .unwrap();

        let pull_request = pull_request_from_response(response).unwrap();
        assert_eq!(pull_request.repo, "o/r");
        assert_eq!(pull_request.number, 57);
        assert_eq!(pull_request.status, "open");
    }
}
