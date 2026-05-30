use std::fs;
use std::path::PathBuf;
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
    if let Some(candidate) = db.next_pull_request_sync_candidate()? {
        return match fetch_linked_pull_requests(&candidate.repo, candidate.issue_number).await {
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
        };
    }

    if let Some(candidate) = db.next_pull_request_status_sync_candidate()? {
        return match fetch_pull_request(&candidate.repo, candidate.number).await {
            Ok(pull_request) => {
                db.record_pull_request_status_sync_success(&candidate, &pull_request)?;
                Ok(PullRequestSyncResult::synced(candidate.task_id, 1))
            }
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

async fn fetch_pull_request(repo: &str, number: i64) -> Result<GithubPullRequest> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| anyhow!("invalid GitHub repo: {repo}"))?;
    let token = github_token()?;
    let crab = Octocrab::builder().personal_token(token).build()?;
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

    if let Some(token) = github_token_from_gh_config()? {
        let _ = GH_AUTH_TOKEN.set(token.clone());
        return Ok(token);
    }

    if let Some(token) = github_token_from_macos_keychain(gh_config_user()?.as_deref())? {
        let _ = GH_AUTH_TOKEN.set(token.clone());
        return Ok(token);
    }

    let message = "GitHub token not found in GH_TOKEN/GITHUB_TOKEN, gh hosts.yml, or macOS Keychain item gh:github.com; run `gh auth login` or set GH_TOKEN/GITHUB_TOKEN";
    cache_auth_failure(message)?;
    Err(anyhow!(message))
}

fn github_token_from_gh_config() -> Result<Option<String>> {
    for path in gh_hosts_paths()? {
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e).with_context(|| format!("failed to read {}", path.display())),
        };
        if let Some(token) = extract_gh_hosts_token(&contents, "github.com") {
            return Ok(Some(token));
        }
    }
    Ok(None)
}

fn gh_config_user() -> Result<Option<String>> {
    for path in gh_hosts_paths()? {
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e).with_context(|| format!("failed to read {}", path.display())),
        };
        if let Some(user) = extract_gh_hosts_user(&contents, "github.com") {
            return Ok(Some(user));
        }
    }
    Ok(None)
}

fn gh_hosts_paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if let Some(dir) = std::env::var_os("GH_CONFIG_DIR") {
        paths.push(PathBuf::from(dir).join("hosts.yml"));
    }
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(dir).join("gh").join("hosts.yml"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(
            PathBuf::from(home)
                .join(".config")
                .join("gh")
                .join("hosts.yml"),
        );
    }
    if paths.is_empty() {
        return Err(anyhow!(
            "neither GH_CONFIG_DIR, XDG_CONFIG_HOME, nor HOME is set"
        ));
    }
    Ok(paths)
}

fn extract_gh_hosts_token(contents: &str, host: &str) -> Option<String> {
    extract_gh_hosts_value(contents, host, &["oauth_token", "token"])
}

fn extract_gh_hosts_user(contents: &str, host: &str) -> Option<String> {
    extract_gh_hosts_value(contents, host, &["user"])
}

fn extract_gh_hosts_value(contents: &str, host: &str, keys: &[&str]) -> Option<String> {
    let mut in_host = false;
    for line in contents.lines() {
        if !line.starts_with(char::is_whitespace) && line.trim_end().ends_with(':') {
            in_host = line.trim_end_matches(':') == host;
            continue;
        }
        if !in_host {
            continue;
        }
        let trimmed = line.trim();
        for key in keys {
            let Some(value) = trimmed.strip_prefix(&format!("{key}:")) else {
                continue;
            };
            let value = clean_yaml_scalar(value)?;
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn clean_yaml_scalar(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(value);
    Some(value.to_string())
}

#[cfg(target_os = "macos")]
fn github_token_from_macos_keychain(user: Option<&str>) -> Result<Option<String>> {
    if let Some(user) = user {
        if let Some(token) = find_macos_keychain_password(&[
            "find-generic-password",
            "-s",
            "gh:github.com",
            "-a",
            user,
            "-w",
        ])? {
            return Ok(Some(token));
        }
    }
    find_macos_keychain_password(&["find-generic-password", "-s", "gh:github.com", "-w"])
}

#[cfg(not(target_os = "macos"))]
fn github_token_from_macos_keychain(_user: Option<&str>) -> Result<Option<String>> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn find_macos_keychain_password(args: &[&str]) -> Result<Option<String>> {
    let output = Command::new("/usr/bin/security")
        .args(args)
        .output()
        .context("failed to run /usr/bin/security for GitHub token lookup")?;
    if !output.status.success() {
        return Ok(None);
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!token.is_empty()).then_some(token))
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
        extract_gh_hosts_token, extract_gh_hosts_user, linked_pull_requests_from_response,
        pull_request_from_response, LinkedPullRequestsResponse, PullRequestResponse,
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

    #[test]
    fn extracts_token_and_user_from_gh_hosts_config() {
        let hosts = r#"
github.com:
    git_protocol: ssh
    oauth_token: "gho_secret"
    user: ashigirl96
example.com:
    oauth_token: wrong
"#;

        assert_eq!(
            extract_gh_hosts_token(hosts, "github.com").as_deref(),
            Some("gho_secret")
        );
        assert_eq!(
            extract_gh_hosts_user(hosts, "github.com").as_deref(),
            Some("ashigirl96")
        );
    }

    #[test]
    fn extracts_nested_user_token_from_gh_hosts_config() {
        let hosts = r#"
github.com:
    users:
        ashigirl96:
            oauth_token: gho_nested
    git_protocol: ssh
    user: ashigirl96
"#;

        assert_eq!(
            extract_gh_hosts_token(hosts, "github.com").as_deref(),
            Some("gho_nested")
        );
    }
}
