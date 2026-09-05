use anyhow::Result;

use crate::{FetchedIssue, GithubIssue, GithubPullRequest, RepoPullRequest};

use crate::ports::BoxFuture;

pub trait GithubGateway {
    fn fetch_issue<'a>(&'a self, repo: &'a str, number: i64) -> BoxFuture<'a, Result<GithubIssue>>;
    /// The named issues of one repo in as few requests as possible. Missing or inaccessible
    /// numbers are dropped rather than failing the batch, so one deleted issue cannot stall the
    /// sync of its repo.
    fn fetch_issues<'a>(
        &'a self,
        repo: &'a str,
        numbers: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<FetchedIssue>>>;
    fn fetch_default_branch<'a>(&'a self, repo: &'a str) -> BoxFuture<'a, Result<Option<String>>>;
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
