use anyhow::Result;

use crate::{GithubIssue, GithubPullRequest, RepoPullRequest};

use crate::ports::BoxFuture;

pub trait GithubGateway {
    fn fetch_issue<'a>(&'a self, repo: &'a str, number: i64) -> BoxFuture<'a, Result<GithubIssue>>;
    fn fetch_default_branch<'a>(&'a self, repo: &'a str) -> BoxFuture<'a, Result<Option<String>>>;
    fn fetch_pull_requests_by_branch<'a>(
        &'a self,
        repo: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<Vec<GithubPullRequest>>>;
    fn fetch_pull_request<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> BoxFuture<'a, Result<GithubPullRequest>>;
    /// Every recently-updated PR in the repo (state=all, newest 100), each tagged with its head
    /// branch so a bulk sync can match it to a task without a per-branch request.
    fn fetch_recent_pull_requests<'a>(
        &'a self,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RepoPullRequest>>>;
}
