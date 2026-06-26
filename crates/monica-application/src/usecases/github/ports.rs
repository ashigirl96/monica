use anyhow::Result;

use crate::ports::BoxFuture;
use crate::{GithubAuthStatus, GithubDeviceFlow, GithubIssue, GithubPullRequest};

pub use crate::usecases::projects::ports::ProjectRepository;
pub use crate::usecases::tasks::ports::TaskRepository;

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
}

pub trait AuthGateway {
    fn status(&self) -> GithubAuthStatus;
    fn begin_device_flow<'a>(&'a self) -> BoxFuture<'a, Result<GithubDeviceFlow>>;
    fn wait_for_device_flow<'a>(
        &'a self,
        flow: &'a GithubDeviceFlow,
    ) -> BoxFuture<'a, Result<GithubAuthStatus>>;
    fn logout<'a>(&'a self) -> BoxFuture<'a, Result<()>>;
}
