use anyhow::{anyhow, Result};
use octocrab::Octocrab;
use serde::Deserialize;
use serde_json::json;

use crate::{GithubIssue, GithubPullRequest};

use super::auth::{github_app_install_url, GithubTokenProvider};

#[derive(Debug, Default, Clone, Copy)]
pub struct GithubApiClient {
    token_provider: GithubTokenProvider,
}

impl GithubApiClient {
    pub fn new() -> Self {
        Self {
            token_provider: GithubTokenProvider::new(),
        }
    }

    pub async fn fetch_issue(&self, repo: &str, number: i64) -> Result<GithubIssue> {
        let (owner, name) = split_repo(repo)?;
        let route = format!("/repos/{owner}/{name}/issues/{number}");
        let issue: IssueResponse = self
            .crab()
            .await?
            .get(route, None::<&()>)
            .await
            .map_err(|e| map_github_error(e, &format!("fetch issue {repo}#{number}")))?;
        issue_from_response(issue, number)
    }

    pub async fn fetch_default_branch(&self, repo: &str) -> Result<Option<String>> {
        let (owner, name) = split_repo(repo)?;
        let route = format!("/repos/{owner}/{name}");
        let response: RepoResponse = self
            .crab()
            .await?
            .get(route, None::<&()>)
            .await
            .map_err(|e| map_github_error(e, &format!("fetch repository {repo}")))?;
        Ok((!response.default_branch.trim().is_empty()).then_some(response.default_branch))
    }

    pub async fn fetch_linked_pull_requests(
        &self,
        repo: &str,
        issue_number: i64,
    ) -> Result<Vec<GithubPullRequest>> {
        let (owner, name) = split_repo(repo)?;
        let payload = json!({
            "query": LINKED_PULL_REQUESTS_QUERY,
            "variables": {
                "owner": owner,
                "name": name,
                "number": issue_number,
                "first": 20,
            },
        });
        let response: LinkedPullRequestsResponse =
            self.crab().await?.graphql(&payload).await.map_err(|e| {
                map_github_error(
                    e,
                    &format!("fetch linked pull requests for {repo}#{issue_number}"),
                )
            })?;
        linked_pull_requests_from_response(response)
    }

    pub async fn fetch_pull_request(&self, repo: &str, number: i64) -> Result<GithubPullRequest> {
        let (owner, name) = split_repo(repo)?;
        let payload = json!({
            "query": PULL_REQUEST_QUERY,
            "variables": {
                "owner": owner,
                "name": name,
                "number": number,
            },
        });
        let response: PullRequestResponse = self
            .crab()
            .await?
            .graphql(&payload)
            .await
            .map_err(|e| map_github_error(e, &format!("fetch pull request {repo}#{number}")))?;
        pull_request_from_response(response)
    }

    async fn crab(&self) -> Result<Octocrab> {
        let token = self.token_provider.access_token().await?;
        Octocrab::builder()
            .personal_token(token)
            .build()
            .map_err(Into::into)
    }
}

fn split_repo(repo: &str) -> Result<(&str, &str)> {
    repo.split_once('/')
        .ok_or_else(|| anyhow!("invalid GitHub repo: {repo}"))
}

fn map_github_error(error: octocrab::Error, action: &str) -> anyhow::Error {
    let install_url = github_app_install_url();
    match error {
        octocrab::Error::GitHub { source, .. } => {
            let status = source.status_code.as_u16();
            match status {
                401 => anyhow!(
                    "GitHub auth failed while trying to {action}: {}; run `monica auth github login`",
                    source.message
                ),
                403 => anyhow!(
                    "GitHub denied access while trying to {action}: {}. Confirm the Monica GitHub App has Issues/Pull requests read permission and is installed for this repository: {install_url}",
                    source.message
                ),
                404 => anyhow!(
                    "GitHub repository or item was not found while trying to {action}: {}. The Monica GitHub App may not be installed for this repository or the repository may not be selected: {install_url}",
                    source.message
                ),
                _ => anyhow!("GitHub API error while trying to {action}: {source}"),
            }
        }
        octocrab::Error::Graphql { source, .. } => anyhow!(
            "GitHub GraphQL error while trying to {action}: {source}. Confirm the Monica GitHub App has Issues/Pull requests read permission and is installed for this repository: {install_url}"
        ),
        other => anyhow!("GitHub API error while trying to {action}: {other}"),
    }
}

fn linked_pull_requests_from_response(
    response: LinkedPullRequestsResponse,
) -> Result<Vec<GithubPullRequest>> {
    let repository = response
        .repository
        .ok_or_else(|| anyhow!("GitHub repository was not found; check GitHub App installation"))?;
    let issue = repository
        .issue
        .ok_or_else(|| anyhow!("GitHub issue was not found; check GitHub App repository access"))?;
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
        .ok_or_else(|| anyhow!("GitHub repository was not found; check GitHub App installation"))?;
    let node = repository.pull_request.ok_or_else(|| {
        anyhow!("GitHub pull request was not found; check GitHub App repository access")
    })?;
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

fn issue_from_response(issue: IssueResponse, requested: i64) -> Result<GithubIssue> {
    // GitHub's REST issues endpoint also resolves pull-request numbers and returns
    // them carrying a `pull_request` object; reject those so a PR is not tracked as
    // an issue (the old `gh issue view` path errored on PR numbers).
    if issue.pull_request.is_some() {
        return Err(anyhow!(
            "GitHub #{requested} is a pull request, not an issue"
        ));
    }
    if issue.number != requested {
        return Err(anyhow!(
            "GitHub returned issue #{} but #{requested} was requested",
            issue.number
        ));
    }
    Ok(GithubIssue {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.html_url,
    })
}

#[derive(Debug, Deserialize)]
struct IssueResponse {
    number: i64,
    title: String,
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RepoResponse {
    default_branch: String,
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
        issue_from_response, linked_pull_requests_from_response, pull_request_from_response,
    };
    use super::{IssueResponse, LinkedPullRequestsResponse, PullRequestResponse};

    fn issue_response(value: serde_json::Value) -> IssueResponse {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn issue_from_response_maps_fields_and_tolerates_missing_body() {
        let issue = issue_from_response(
            issue_response(serde_json::json!({
                "number": 9,
                "title": "hello",
                "html_url": "https://github.com/o/r/issues/9"
            })),
            9,
        )
        .unwrap();
        assert_eq!(issue.number, 9);
        assert_eq!(issue.title, "hello");
        assert_eq!(issue.body, None);
        assert_eq!(issue.url, "https://github.com/o/r/issues/9");

        let null_body = issue_from_response(
            issue_response(serde_json::json!({
                "number": 9, "title": "t", "body": null, "html_url": "u"
            })),
            9,
        )
        .unwrap();
        assert_eq!(null_body.body, None);
    }

    #[test]
    fn issue_from_response_rejects_pull_request() {
        let err = issue_from_response(
            issue_response(serde_json::json!({
                "number": 57,
                "title": "a pr",
                "html_url": "https://github.com/o/r/pull/57",
                "pull_request": { "url": "https://api.github.com/repos/o/r/pulls/57" }
            })),
            57,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("pull request"), "{err:#}");
    }

    #[test]
    fn issue_from_response_rejects_number_mismatch() {
        let err = issue_from_response(
            issue_response(serde_json::json!({
                "number": 9, "title": "t", "html_url": "u"
            })),
            5,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("#9"), "{err:#}");
    }

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
