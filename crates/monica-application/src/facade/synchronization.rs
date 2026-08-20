use super::{Backend, Monica};
use crate::usecases::github::{TrackGithubIssueInput, TrackGithubIssueReport};
use crate::{ApplicationEvent, ApplicationResult, GithubAuthStatus, GithubDeviceFlow};

/// GitHub-facing synchronization: auth, issue tracking, and pull-request sync.
pub struct SynchronizationService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> SynchronizationService<'_, B> {
    pub fn auth_status(&self) -> GithubAuthStatus {
        crate::usecases::github::github_auth_status(&self.m.auth)
    }

    pub async fn begin_device_flow(&self) -> ApplicationResult<GithubDeviceFlow> {
        crate::usecases::github::begin_github_device_flow(&self.m.auth).await
    }

    pub async fn wait_for_device_flow(
        &self,
        flow: &GithubDeviceFlow,
    ) -> ApplicationResult<GithubAuthStatus> {
        crate::usecases::github::wait_for_github_device_flow(&self.m.auth, flow).await
    }

    pub async fn logout(&self) -> ApplicationResult<()> {
        crate::usecases::github::logout_github(&self.m.auth).await
    }

    pub async fn track_github_issue(
        &mut self,
        repo: String,
        number: i64,
    ) -> ApplicationResult<TrackGithubIssueReport> {
        let input = TrackGithubIssueInput { repo, number };
        let Monica { repos, github, .. } = &mut *self.m;
        crate::usecases::github::track_github_issue(repos, github, input).await
    }

    /// User-forced refresh (cmd+r / entering the Workboard) — the only PR sync path. Fetches each
    /// tracked repo's PRs once, matches them to branches in bulk, re-checks unresolved tracked PRs
    /// the branch pass didn't cover, then announces completion. A no-op when GitHub isn't
    /// authenticated.
    pub async fn force_sync_pull_requests(&mut self) -> ApplicationResult<u32> {
        if !self.auth_status().authenticated {
            return Ok(0);
        }
        let synced_count = {
            let Monica { repos, github, .. } = &mut *self.m;
            crate::usecases::github::bulk_sync_pull_requests(repos, github).await?
        };
        self.m
            .events
            .emit(ApplicationEvent::PullRequestSyncCompleted { synced_count });
        Ok(synced_count)
    }
}
