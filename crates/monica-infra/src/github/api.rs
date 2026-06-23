use anyhow::{anyhow, Result};
use monica_core::{GithubGateway, GithubIssue, GithubPullRequest, GithubPullRequestStatus};
use octocrab::Octocrab;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::auth::GithubTokenProvider;

#[derive(Debug, Default, Clone, Copy)]
pub struct GithubApiClient {
    token_provider: GithubTokenProvider,
}

pub type OctocrabGithubGateway = GithubApiClient;

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

    pub async fn fetch_pull_requests_by_branch(
        &self,
        repo: &str,
        branch: &str,
    ) -> Result<Vec<GithubPullRequest>> {
        let (owner, name) = split_repo(repo)?;
        let route = format!("/repos/{owner}/{name}/pulls");
        let params = PullRequestsByBranchParams {
            state: "all",
            head: format!("{owner}:{branch}"),
            sort: "updated",
            direction: "desc",
            per_page: 100,
        };
        let response: Vec<BranchPullRequestResponse> = self
            .crab()
            .await?
            .get(route, Some(&params))
            .await
            .map_err(|e| {
                map_github_error(
                    e,
                    &format!("fetch pull requests for branch {repo}@{branch}"),
                )
            })?;
        branch_pull_requests_from_response(repo, response)
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
    match error {
        octocrab::Error::GitHub { source, .. } => {
            let status = source.status_code.as_u16();
            match status {
                401 => anyhow!(
                    "GitHub auth failed while trying to {action}: {}; run `monica auth github login`",
                    source.message
                ),
                403 => anyhow!(
                    "GitHub denied access while trying to {action}: {}. Your token may lack the `repo` scope, or an organization may restrict Monica's OAuth app — re-run `monica auth github login` and, for organization repositories, ask an org owner to approve Monica (and authorize SSO) in the organization's third-party access settings.",
                    source.message
                ),
                404 => anyhow!(
                    "GitHub repository or item was not found while trying to {action}: {}. Confirm you have access to the repository; for organization repositories an org owner may need to approve Monica's OAuth app or grant SSO authorization.",
                    source.message
                ),
                _ => anyhow!("GitHub API error while trying to {action}: {source}"),
            }
        }
        octocrab::Error::Graphql { source, .. } => anyhow!(
            "GitHub GraphQL error while trying to {action}: {source}. Confirm you have access to the repository and that Monica's OAuth app is authorized (re-run `monica auth github login`; org repositories may require org owner approval)."
        ),
        other => anyhow!("GitHub API error while trying to {action}: {other}"),
    }
}

fn pull_request_from_response(response: PullRequestResponse) -> Result<GithubPullRequest> {
    let repository = response
        .repository
        .ok_or_else(|| anyhow!("GitHub repository was not found; confirm you have access to it"))?;
    let node = repository.pull_request.ok_or_else(|| {
        anyhow!("GitHub pull request was not found; confirm you have access to the repository")
    })?;
    if node.number <= 0 {
        return Err(anyhow!("GitHub pull request returned invalid number"));
    }
    Ok(GithubPullRequest {
        repo: pull_request_repo(&node),
        number: node.number,
        url: node.url,
        status: resolve_pull_request_status(&node.state, node.is_draft, None)?,
    })
}

fn pull_request_repo(node: &PullRequestNode) -> String {
    node.repository.name_with_owner.to_lowercase()
}

fn resolve_pull_request_status(
    state: &str,
    is_draft: bool,
    merged_at: Option<&str>,
) -> Result<GithubPullRequestStatus> {
    let state = state.to_ascii_lowercase();
    if state == "open" && is_draft {
        Ok(GithubPullRequestStatus::Draft)
    } else if state == "closed" && merged_at.is_some_and(|value| !value.trim().is_empty()) {
        Ok(GithubPullRequestStatus::Merged)
    } else {
        Ok(state.parse()?)
    }
}

fn branch_pull_requests_from_response(
    repo: &str,
    response: Vec<BranchPullRequestResponse>,
) -> Result<Vec<GithubPullRequest>> {
    let mut candidates: Vec<(String, GithubPullRequest)> = Vec::new();
    for node in response {
        if node.number <= 0 {
            continue;
        }
        candidates.push((
            node.updated_at,
            GithubPullRequest {
                repo: repo.to_ascii_lowercase(),
                number: node.number,
                url: node.html_url,
                status: resolve_pull_request_status(
                    &node.state,
                    node.draft,
                    node.merged_at.as_deref(),
                )?,
            },
        ));
    }
    Ok(candidates
        .into_iter()
        .max_by(|(updated_a, pr_a), (updated_b, pr_b)| {
            branch_pull_request_rank(pr_a.status)
                .cmp(&branch_pull_request_rank(pr_b.status))
                .then_with(|| updated_a.cmp(updated_b))
                .then_with(|| pr_a.number.cmp(&pr_b.number))
        })
        .map(|(_, pr)| pr)
        .into_iter()
        .collect())
}

fn branch_pull_request_rank(status: GithubPullRequestStatus) -> u8 {
    match status {
        GithubPullRequestStatus::Draft | GithubPullRequestStatus::Open => 3,
        GithubPullRequestStatus::Merged => 2,
        GithubPullRequestStatus::Closed => 1,
    }
}

impl GithubGateway for GithubApiClient {
    fn fetch_issue<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> monica_core::interfaces::BoxFuture<'a, Result<GithubIssue>> {
        Box::pin(async move { GithubApiClient::fetch_issue(self, repo, number).await })
    }

    fn fetch_default_branch<'a>(
        &'a self,
        repo: &'a str,
    ) -> monica_core::interfaces::BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async move { GithubApiClient::fetch_default_branch(self, repo).await })
    }

    fn fetch_pull_requests_by_branch<'a>(
        &'a self,
        repo: &'a str,
        branch: &'a str,
    ) -> monica_core::interfaces::BoxFuture<'a, Result<Vec<GithubPullRequest>>> {
        Box::pin(
            async move { GithubApiClient::fetch_pull_requests_by_branch(self, repo, branch).await },
        )
    }

    fn fetch_pull_request<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> monica_core::interfaces::BoxFuture<'a, Result<GithubPullRequest>> {
        Box::pin(async move { GithubApiClient::fetch_pull_request(self, repo, number).await })
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

#[derive(Debug, Serialize)]
struct PullRequestsByBranchParams {
    state: &'static str,
    head: String,
    sort: &'static str,
    direction: &'static str,
    per_page: u8,
}

#[derive(Debug, Deserialize)]
struct BranchPullRequestResponse {
    number: i64,
    html_url: String,
    state: String,
    #[serde(default)]
    draft: bool,
    updated_at: String,
    merged_at: Option<String>,
}

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
    use monica_core::GithubPullRequestStatus;

    use super::{
        branch_pull_requests_from_response, issue_from_response, pull_request_from_response,
    };
    use super::{BranchPullRequestResponse, IssueResponse, PullRequestResponse};

    fn issue_response(value: serde_json::Value) -> IssueResponse {
        serde_json::from_value(value).unwrap()
    }

    fn branch_pr_response(value: serde_json::Value) -> BranchPullRequestResponse {
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
        assert_eq!(pull_request.status, GithubPullRequestStatus::Open);
    }

    #[test]
    fn extracts_branch_pull_request_status_from_rest_response() {
        for (value, expected) in [
            (
                serde_json::json!({
                    "number": 1,
                    "html_url": "https://github.com/O/R/pull/1",
                    "state": "open",
                    "draft": true,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "merged_at": null
                }),
                GithubPullRequestStatus::Draft,
            ),
            (
                serde_json::json!({
                    "number": 2,
                    "html_url": "https://github.com/O/R/pull/2",
                    "state": "open",
                    "draft": false,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "merged_at": null
                }),
                GithubPullRequestStatus::Open,
            ),
            (
                serde_json::json!({
                    "number": 3,
                    "html_url": "https://github.com/O/R/pull/3",
                    "state": "closed",
                    "draft": false,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "merged_at": "2026-01-01T00:00:00Z"
                }),
                GithubPullRequestStatus::Merged,
            ),
            (
                serde_json::json!({
                    "number": 4,
                    "html_url": "https://github.com/O/R/pull/4",
                    "state": "closed",
                    "draft": false,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "merged_at": null
                }),
                GithubPullRequestStatus::Closed,
            ),
        ] {
            let pull_requests =
                branch_pull_requests_from_response("Owner/Repo", vec![branch_pr_response(value)])
                    .unwrap();
            assert_eq!(pull_requests.len(), 1);
            assert_eq!(pull_requests[0].repo, "owner/repo");
            assert_eq!(pull_requests[0].status, expected);
        }
    }

    #[test]
    fn branch_pull_request_selection_prefers_active_then_recent_then_number() {
        let pull_requests = branch_pull_requests_from_response(
            "owner/repo",
            vec![
                branch_pr_response(serde_json::json!({
                    "number": 90,
                    "html_url": "https://github.com/owner/repo/pull/90",
                    "state": "closed",
                    "draft": false,
                    "updated_at": "2030-01-01T00:00:00Z",
                    "merged_at": null
                })),
                branch_pr_response(serde_json::json!({
                    "number": 80,
                    "html_url": "https://github.com/owner/repo/pull/80",
                    "state": "closed",
                    "draft": false,
                    "updated_at": "2029-01-01T00:00:00Z",
                    "merged_at": "2029-01-01T00:00:00Z"
                })),
                branch_pr_response(serde_json::json!({
                    "number": 12,
                    "html_url": "https://github.com/owner/repo/pull/12",
                    "state": "open",
                    "draft": false,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "merged_at": null
                })),
                branch_pr_response(serde_json::json!({
                    "number": 13,
                    "html_url": "https://github.com/owner/repo/pull/13",
                    "state": "open",
                    "draft": true,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "merged_at": null
                })),
            ],
        )
        .unwrap();

        assert_eq!(pull_requests.len(), 1);
        assert_eq!(pull_requests[0].number, 13);
        assert_eq!(pull_requests[0].status, GithubPullRequestStatus::Draft);
    }
}
