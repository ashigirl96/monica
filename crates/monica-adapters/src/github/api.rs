use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use monica_application::{
    FetchedIssue, GithubGateway, GithubIssue, GithubIssueState, GithubPullRequest,
    GithubPullRequestStatus, IssueAddress, RepoPullRequest,
};
use octocrab::Octocrab;
use serde::de::DeserializeOwned;
use serde::Deserialize;
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

    pub async fn fetch_issues(&self, repo: &str, numbers: &[i64]) -> Result<Vec<FetchedIssue>> {
        let (owner, name) = split_repo(repo)?;
        // `crab()` builds a fresh client — new TLS config, new connection pool — so it is hoisted
        // out of the chunk loop rather than paid per request.
        let crab = self.crab().await?;
        let action = format!("fetch issues for {repo}");
        let mut issues = Vec::with_capacity(numbers.len());
        for chunk in numbers.chunks(ISSUE_BATCH) {
            let payload = json!({
                "query": issues_query(chunk),
                "variables": { "owner": owner, "name": name },
            });
            issues.extend(issues_from_response(graphql(&crab, &payload, &action).await?)?);
        }
        Ok(issues)
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

    pub async fn fetch_recent_pull_requests(&self, repo: &str) -> Result<Vec<RepoPullRequest>> {
        let (owner, name) = split_repo(repo)?;
        // GraphQL with explicit field selection, not REST `/pulls`: the REST listing returns the
        // full PR object per row (user, labels, head/base repos, …), which is megabytes for 100 PRs
        // and dominates the forced refresh. We only need six fields to match a PR to a branch.
        let payload = json!({
            "query": RECENT_PULL_REQUESTS_QUERY,
            "variables": { "owner": owner, "name": name },
        });
        let action = format!("fetch recent pull requests for {repo}");
        let response = graphql(&self.crab().await?, &payload, &action).await?;
        recent_pull_requests_from_response(response)
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
        let action = format!("fetch pull request {repo}#{number}");
        let response = graphql(&self.crab().await?, &payload, &action).await?;
        pull_request_from_response(response)
    }

    async fn crab(&self) -> Result<Octocrab> {
        // access_token shells out to `gh` on a cold cache, which can block on a
        // Keychain prompt; keep that off the async runtime's worker threads.
        let provider = self.token_provider;
        let token = tokio::task::spawn_blocking(move || provider.access_token())
            .await
            .context("GitHub token task failed")??;
        Octocrab::builder()
            .personal_token(token)
            .build()
            .map_err(Into::into)
    }
}

async fn graphql<T: DeserializeOwned>(
    crab: &Octocrab,
    payload: &serde_json::Value,
    action: &str,
) -> Result<T> {
    crab.graphql(payload)
        .await
        .map_err(|e| map_github_error(e, action))
}

fn repository_not_found() -> anyhow::Error {
    anyhow!("GitHub repository was not found; confirm you have access to it")
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
                    "GitHub auth failed while trying to {action}: {}; run `gh auth login`, then restart Monica so it picks up the new token",
                    source.message
                ),
                403 => anyhow!(
                    "GitHub denied access while trying to {action}: {}. Your gh token may lack the `repo` scope (`gh auth refresh -s repo`), or the organization may require SSO authorization for the token (`gh auth refresh`). Restart Monica after refreshing so it picks up the new token.",
                    source.message
                ),
                404 => anyhow!(
                    "GitHub repository or item was not found while trying to {action}: {}. Confirm you have access to the repository; organization repositories may require SSO authorization for your gh token.",
                    source.message
                ),
                _ => anyhow!("GitHub API error while trying to {action}: {source}"),
            }
        }
        octocrab::Error::Graphql { source, .. } => anyhow!(
            "GitHub GraphQL error while trying to {action}: {source}. Confirm you have access to the repository and that your gh token is authorized (`gh auth status`; org repositories may require SSO authorization)."
        ),
        other => anyhow!("GitHub API error while trying to {action}: {other}"),
    }
}

fn pull_request_from_response(response: PullRequestResponse) -> Result<GithubPullRequest> {
    let repository = response
        .repository
        .ok_or_else(repository_not_found)?;
    let node = repository.pull_request.ok_or_else(|| {
        anyhow!("GitHub pull request was not found; confirm you have access to the repository")
    })?;
    if node.number <= 0 {
        return Err(anyhow!("GitHub pull request returned invalid number"));
    }
    github_pull_request_from(node)
}

fn github_pull_request_from(node: PullRequestNode) -> Result<GithubPullRequest> {
    Ok(GithubPullRequest {
        repo: node.repository.name_with_owner.to_lowercase(),
        number: node.number,
        url: node.url,
        status: resolve_pull_request_status(&node.state, node.is_draft)?,
    })
}

fn resolve_pull_request_status(state: &str, is_draft: bool) -> Result<GithubPullRequestStatus> {
    let state = state.to_ascii_lowercase();
    if state == "open" && is_draft {
        Ok(GithubPullRequestStatus::Draft)
    } else {
        Ok(state.parse()?)
    }
}

fn recent_pull_requests_from_response(
    response: RecentPullRequestsResponse,
) -> Result<Vec<RepoPullRequest>> {
    let repository = response
        .repository
        .ok_or_else(repository_not_found)?;
    let nodes = repository.pull_requests.nodes;
    let mut pull_requests = Vec::with_capacity(nodes.len());
    for node in nodes {
        if node.number <= 0 {
            continue;
        }
        pull_requests.push(RepoPullRequest {
            number: node.number,
            url: node.url,
            status: resolve_pull_request_status(&node.state, node.is_draft)?,
            head_branch: node.head_ref_name,
            updated_at: node.updated_at,
        });
    }
    Ok(pull_requests)
}

impl GithubGateway for GithubApiClient {
    fn fetch_issue<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> monica_application::ports::BoxFuture<'a, Result<GithubIssue>> {
        Box::pin(async move { GithubApiClient::fetch_issue(self, repo, number).await })
    }

    fn fetch_issues<'a>(
        &'a self,
        repo: &'a str,
        numbers: &'a [i64],
    ) -> monica_application::ports::BoxFuture<'a, Result<Vec<FetchedIssue>>> {
        Box::pin(async move { GithubApiClient::fetch_issues(self, repo, numbers).await })
    }

    fn fetch_default_branch<'a>(
        &'a self,
        repo: &'a str,
    ) -> monica_application::ports::BoxFuture<'a, Result<Option<String>>> {
        Box::pin(async move { GithubApiClient::fetch_default_branch(self, repo).await })
    }

    fn fetch_pull_request<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> monica_application::ports::BoxFuture<'a, Result<GithubPullRequest>> {
        Box::pin(async move { GithubApiClient::fetch_pull_request(self, repo, number).await })
    }

    fn fetch_recent_pull_requests<'a>(
        &'a self,
        repo: &'a str,
    ) -> monica_application::ports::BoxFuture<'a, Result<Vec<RepoPullRequest>>> {
        Box::pin(async move { GithubApiClient::fetch_recent_pull_requests(self, repo).await })
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
        state: parse_issue_state(&issue.state)?,
    })
}

/// REST answers in lowercase and GraphQL in uppercase; both feed the same enum.
fn parse_issue_state(state: &str) -> Result<GithubIssueState> {
    state
        .to_ascii_lowercase()
        .parse()
        .map_err(|_| anyhow!("GitHub returned an unknown issue state: {state}"))
}

/// Aliased `issue(number:)` selections batched into one request. 50 keeps the query well inside
/// GitHub's node limit while collapsing a board's worth of issues into a couple of round trips.
const ISSUE_BATCH: usize = 50;

fn issues_query(numbers: &[i64]) -> String {
    let selections: String = numbers
        .iter()
        .map(|n| {
            format!(
                "    i{n}: issue(number: {n}) {{ number title state \
parent {{ number repository {{ nameWithOwner }} }} \
closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {{ nodes {{ number url state \
isDraft repository {{ nameWithOwner }} }} }} }}\n"
            )
        })
        .collect();
    format!(
        "query MonicaIssues($owner: String!, $name: String!) {{\n  \
repository(owner: $owner, name: $name) {{\n{selections}  }}\n}}\n"
    )
}

fn issues_from_response(response: IssuesResponse) -> Result<Vec<FetchedIssue>> {
    let repository = response
        .repository
        .ok_or_else(repository_not_found)?;
    let mut issues = Vec::with_capacity(repository.len());
    // A null alias is a number that no longer resolves (deleted, transferred, or a PR); skipping
    // it leaves that ref's cached state untouched instead of failing the whole repo.
    for node in repository.into_values().flatten() {
        if node.number <= 0 {
            continue;
        }
        let mut linked_pull_requests = Vec::new();
        for pull_request in node.closed_by_pull_requests_references.nodes {
            if pull_request.number <= 0 {
                continue;
            }
            linked_pull_requests.push(github_pull_request_from(pull_request)?);
        }
        issues.push(FetchedIssue {
            number: node.number,
            title: node.title,
            state: parse_issue_state(&node.state)?,
            // `external_refs.repo` is stored lowercased by `parse_owner_repo`, so the address the
            // sync resolves the parent by has to be lowercased too.
            parent: node.parent.map(|p| IssueAddress {
                repo: p.repository.name_with_owner.to_ascii_lowercase(),
                number: p.number,
            }),
            linked_pull_requests,
        });
    }
    Ok(issues)
}

#[derive(Debug, Deserialize)]
struct IssueResponse {
    number: i64,
    title: String,
    body: Option<String>,
    html_url: String,
    state: String,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct IssuesResponse {
    repository: Option<HashMap<String, Option<IssueNode>>>,
}

#[derive(Debug, Deserialize)]
struct IssueNode {
    number: i64,
    title: String,
    state: String,
    parent: Option<IssueParentNode>,
    #[serde(rename = "closedByPullRequestsReferences")]
    closed_by_pull_requests_references: LinkedPullRequestConnection,
}

/// The PRs whose closing keyword points at this issue.
#[derive(Debug, Deserialize)]
struct LinkedPullRequestConnection {
    nodes: Vec<PullRequestNode>,
}

#[derive(Debug, Deserialize)]
struct IssueParentNode {
    number: i64,
    repository: RepositoryNode,
}

#[derive(Debug, Deserialize)]
struct RepoResponse {
    default_branch: String,
}

const RECENT_PULL_REQUESTS_QUERY: &str = r#"
query MonicaRecentPullRequests($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: 100
      states: [OPEN, CLOSED, MERGED]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        url
        state
        isDraft
        headRefName
        updatedAt
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentPullRequestsResponse {
    repository: Option<RecentPullRequestsRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentPullRequestsRepository {
    pull_requests: RecentPullRequestsConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentPullRequestsConnection {
    nodes: Vec<RecentPullRequestNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentPullRequestNode {
    number: i64,
    url: String,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    updated_at: String,
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
    repository: RepositoryNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryNode {
    name_with_owner: String,
}

#[cfg(test)]
mod tests {
    use monica_application::{GithubIssueState, GithubPullRequestStatus, IssueAddress};

    use super::{
        issue_from_response, issues_from_response, issues_query, pull_request_from_response,
        recent_pull_requests_from_response,
    };
    use super::{IssueResponse, IssuesResponse, PullRequestResponse, RecentPullRequestsResponse};

    fn issue_response(value: serde_json::Value) -> IssueResponse {
        serde_json::from_value(value).unwrap()
    }

    fn recent_prs_response(nodes: serde_json::Value) -> RecentPullRequestsResponse {
        serde_json::from_value(serde_json::json!({
            "repository": { "pullRequests": { "nodes": nodes } }
        }))
        .unwrap()
    }

    #[test]
    fn issue_from_response_maps_fields_and_tolerates_missing_body() {
        let issue = issue_from_response(
            issue_response(serde_json::json!({
                "number": 9,
                "title": "hello",
                "state": "open",
                "html_url": "https://github.com/o/r/issues/9"
            })),
            9,
        )
        .unwrap();
        assert_eq!(issue.number, 9);
        assert_eq!(issue.title, "hello");
        assert_eq!(issue.body, None);
        assert_eq!(issue.url, "https://github.com/o/r/issues/9");
        assert_eq!(issue.state, GithubIssueState::Open);

        let null_body = issue_from_response(
            issue_response(serde_json::json!({
                "number": 9, "title": "t", "body": null, "state": "closed", "html_url": "u"
            })),
            9,
        )
        .unwrap();
        assert_eq!(null_body.body, None);
        assert_eq!(null_body.state, GithubIssueState::Closed);
    }

    #[test]
    fn issue_from_response_rejects_pull_request() {
        let err = issue_from_response(
            issue_response(serde_json::json!({
                "number": 57,
                "title": "a pr",
                "state": "open",
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
                "number": 9, "title": "t", "state": "open", "html_url": "u"
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
    fn recent_pull_requests_keep_all_entries_with_head_branch() {
        let pull_requests = recent_pull_requests_from_response(recent_prs_response(
            serde_json::json!([
                {
                    "number": 12,
                    "url": "https://github.com/o/r/pull/12",
                    "state": "OPEN",
                    "isDraft": false,
                    "headRefName": "feature/a",
                    "updatedAt": "2026-02-01T00:00:00Z"
                },
                {
                    "number": 13,
                    "url": "https://github.com/o/r/pull/13",
                    "state": "MERGED",
                    "isDraft": false,
                    "headRefName": "feature/b",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }
            ]),
        ))
        .unwrap();

        assert_eq!(pull_requests.len(), 2, "all PRs are kept, not reduced");
        assert_eq!(pull_requests[0].number, 12);
        assert_eq!(pull_requests[0].head_branch, "feature/a");
        assert_eq!(pull_requests[0].status, GithubPullRequestStatus::Open);
        assert_eq!(pull_requests[0].updated_at, "2026-02-01T00:00:00Z");
        assert_eq!(pull_requests[1].number, 13);
        assert_eq!(pull_requests[1].head_branch, "feature/b");
        assert_eq!(pull_requests[1].status, GithubPullRequestStatus::Merged);
    }

    #[test]
    fn recent_pull_requests_map_draft_state() {
        let pull_requests = recent_pull_requests_from_response(recent_prs_response(
            serde_json::json!([
                {
                    "number": 14,
                    "url": "https://github.com/o/r/pull/14",
                    "state": "OPEN",
                    "isDraft": true,
                    "headRefName": "feature/draft",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }
            ]),
        ))
        .unwrap();
        assert_eq!(pull_requests.len(), 1);
        assert_eq!(pull_requests[0].status, GithubPullRequestStatus::Draft);
    }

    #[test]
    fn recent_pull_requests_skip_invalid_number() {
        let pull_requests = recent_pull_requests_from_response(recent_prs_response(
            serde_json::json!([
                {
                    "number": 0,
                    "url": "https://github.com/o/r/pull/0",
                    "state": "OPEN",
                    "isDraft": false,
                    "headRefName": "feature/x",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }
            ]),
        ))
        .unwrap();
        assert!(pull_requests.is_empty());
    }


    #[test]
    fn issues_query_aliases_every_requested_number() {
        let query = issues_query(&[42, 7]);
        assert!(query.contains("i42: issue(number: 42)"), "{query}");
        assert!(query.contains("i7: issue(number: 7)"), "{query}");
        // The parent's repo is part of its identity: sub-issues can cross repositories.
        assert!(query.contains("parent { number repository { nameWithOwner } }"), "{query}");
        assert!(!query.contains("subIssues"), "{query}");
        assert!(
            query.contains("closedByPullRequestsReferences(first: 10, includeClosedPrs: true)"),
            "{query}"
        );
    }

    #[test]
    fn issues_from_response_maps_aliases_and_hierarchy() {
        let response: IssuesResponse = serde_json::from_value(serde_json::json!({
            "repository": {
                "i42": {
                    "number": 42,
                    "title": "hello",
                    "state": "OPEN",
                    "parent": { "number": 7, "repository": { "nameWithOwner": "Owner/Repo" } },
                    "closedByPullRequestsReferences": { "nodes": [] }
                }
            }
        }))
        .unwrap();
        let issues = issues_from_response(response).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 42);
        assert_eq!(issues[0].title, "hello");
        // GraphQL shouts its enums; the parse must not care.
        assert_eq!(issues[0].state, GithubIssueState::Open);
        assert_eq!(
            issues[0].parent,
            Some(IssueAddress { repo: "owner/repo".to_string(), number: 7 }),
            "the address must be lowercased to match how external_refs stores a repo"
        );
        assert!(issues[0].linked_pull_requests.is_empty());
    }

    #[test]
    fn issues_from_response_maps_the_pull_requests_that_close_the_issue() {
        let response: IssuesResponse = serde_json::from_value(serde_json::json!({
            "repository": {
                "i484": {
                    "number": 484,
                    "title": "hello",
                    "state": "CLOSED",
                    "parent": null,
                    "closedByPullRequestsReferences": { "nodes": [
                        {
                            "number": 482,
                            "url": "https://github.com/AshiGirl96/Monica/pull/482",
                            "state": "MERGED",
                            "isDraft": false,
                            "repository": { "nameWithOwner": "AshiGirl96/Monica" }
                        },
                        {
                            "number": 483,
                            "url": "https://github.com/o/r/pull/483",
                            "state": "OPEN",
                            "isDraft": true,
                            "repository": { "nameWithOwner": "o/r" }
                        },
                        { "number": 0, "url": "u", "state": "OPEN", "isDraft": false,
                          "repository": { "nameWithOwner": "o/r" } }
                    ] }
                }
            }
        }))
        .unwrap();
        let issues = issues_from_response(response).unwrap();
        let linked = &issues[0].linked_pull_requests;
        assert_eq!(linked.len(), 2, "the invalid number is dropped");
        assert_eq!(linked[0].number, 482);
        // The PR's own repo is what gets recorded, normalized the way refs are stored.
        assert_eq!(linked[0].repo, "ashigirl96/monica");
        assert_eq!(linked[0].status, GithubPullRequestStatus::Merged);
        // An open PR marked draft resolves to Draft, same as the by-number lookup.
        assert_eq!(linked[1].status, GithubPullRequestStatus::Draft);
    }

    #[test]
    fn issues_from_response_skips_unresolvable_aliases() {
        let response: IssuesResponse = serde_json::from_value(serde_json::json!({
            "repository": {
                "i42": null,
                "i7": {
                    "number": 7,
                    "title": "kept",
                    "state": "CLOSED",
                    "parent": null,
                    "closedByPullRequestsReferences": { "nodes": [] }
                }
            }
        }))
        .unwrap();
        let issues = issues_from_response(response).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 7);
        assert_eq!(issues[0].state, GithubIssueState::Closed);
        assert_eq!(issues[0].parent, None);
    }

    #[test]
    fn issues_from_response_rejects_a_missing_repository() {
        let response: IssuesResponse =
            serde_json::from_value(serde_json::json!({ "repository": null })).unwrap();
        let err = issues_from_response(response).unwrap_err();
        assert!(format!("{err:#}").contains("not found"), "{err:#}");
    }
}
