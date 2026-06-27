use super::{Backend, Monica};
use crate::ports::PullRequestSyncStore;
use crate::usecases::github::{TrackGithubIssueInput, TrackGithubIssueReport};
use crate::{
    ApplicationEvent, ApplicationResult, GithubAuthStatus, GithubDeviceFlow, PullRequestSyncResult,
    PullRequestSyncStatus,
};

/// GitHub-facing synchronization: auth, issue tracking, and pull-request sync.
pub struct SynchronizationService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> SynchronizationService<'_, B> {
    pub fn auth_status(&self) -> GithubAuthStatus {
        crate::usecases::github::github_auth_status(&self.m.auth)
    }

    /// Reset PR status-sync retry state so the next (forced) sweep re-checks open/draft PRs.
    pub fn reset_pull_request_sync(&mut self) -> ApplicationResult<()> {
        Ok(self.m.repos.force_clear_pr_sync_state()?)
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

    pub async fn sync_next_pull_request(&mut self) -> ApplicationResult<PullRequestSyncResult> {
        let Monica { repos, github, .. } = &mut *self.m;
        crate::usecases::github::sync_next_pull_request(repos, github).await
    }

    /// Drain up to `limit` pending PR-sync candidates, stopping early when idle. Returns the count
    /// actually synced. `announce` emits [`ApplicationEvent::PullRequestSyncCompleted`] (used for
    /// the user-forced sync; the periodic sweep stays quiet to avoid frontend churn). A no-op when
    /// GitHub isn't authenticated.
    pub async fn sync_pull_requests(&mut self, limit: usize, announce: bool) -> ApplicationResult<u32> {
        if !self.auth_status().authenticated {
            return Ok(0);
        }
        let mut synced_count = 0u32;
        for _ in 0..limit {
            let result = match self.sync_next_pull_request().await {
                Ok(result) => result,
                Err(e) => {
                    log::error!(target: "monica_application::pr_sync", "PR sync failed: {e}");
                    break;
                }
            };
            match result.status {
                PullRequestSyncStatus::Idle => break,
                PullRequestSyncStatus::Synced => {
                    synced_count += 1;
                    log::info!(
                        target: "monica_application::pr_sync",
                        "PR synced task_id={} pull_request_count={}",
                        result.task_id.as_deref().unwrap_or("-"),
                        result.pull_request_count
                    );
                }
                // A failure records a retry backoff on the candidate, so it won't recur in this
                // batch; keep draining other candidates rather than aborting the whole sweep.
                PullRequestSyncStatus::Failed => {
                    log::warn!(
                        target: "monica_application::pr_sync",
                        "PR sync recorded failure task_id={} error={}",
                        result.task_id.as_deref().unwrap_or("-"),
                        result.error.as_deref().unwrap_or("-")
                    );
                }
            }
        }
        if announce {
            self.m
                .events
                .emit(ApplicationEvent::PullRequestSyncCompleted { synced_count });
        }
        Ok(synced_count)
    }
}
