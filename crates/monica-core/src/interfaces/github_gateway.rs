use anyhow::Result;

use crate::{GithubIssue, GithubPullRequest};

use super::BoxFuture;

pub trait GithubGateway {
    fn fetch_issue<'a>(&'a self, repo: &'a str, number: i64) -> BoxFuture<'a, Result<GithubIssue>>;
    fn fetch_default_branch<'a>(&'a self, repo: &'a str) -> BoxFuture<'a, Result<Option<String>>>;
    fn fetch_linked_pull_requests<'a>(
        &'a self,
        repo: &'a str,
        issue_number: i64,
    ) -> BoxFuture<'a, Result<Vec<GithubPullRequest>>>;
    fn fetch_pull_request<'a>(
        &'a self,
        repo: &'a str,
        number: i64,
    ) -> BoxFuture<'a, Result<GithubPullRequest>>;
}
