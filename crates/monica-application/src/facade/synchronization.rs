use super::{Backend, Monica};
use crate::prelude::TaskId;
use crate::usecases::github::{
    LinkPullRequestReport, TrackGithubIssueInput, TrackGithubIssueReport,
};
use crate::{ApplicationEvent, ApplicationResult, GithubAuthStatus};

/// GitHub-facing synchronization: auth status, issue tracking, and the forced GitHub refresh.
pub struct SynchronizationService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> SynchronizationService<'_, B> {
    pub fn auth_status(&self) -> GithubAuthStatus {
        crate::usecases::github::github_auth_status(&self.m.auth)
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

    /// Attach a pull request to a task by hand, for the PRs the forced sync cannot discover.
    pub async fn link_pull_request(
        &mut self,
        task_id: &TaskId,
        repo: String,
        number: i64,
    ) -> ApplicationResult<LinkPullRequestReport> {
        let Monica { repos, github, .. } = &mut *self.m;
        crate::usecases::github::link_pull_request(repos, github, task_id, repo, number).await
    }

    /// User-forced refresh (cmd+r / entering the Workboard) — the only GitHub sync path. Runs the
    /// PR pass (repo listings matched to branches, then unresolved refs re-checked) followed by the
    /// issue pass (open tasks' issue titles and states), then announces completion. A no-op when
    /// GitHub isn't authenticated.
    pub async fn force_sync_github(&mut self) -> ApplicationResult<u32> {
        if !self.auth_status().authenticated {
            return Ok(0);
        }
        let synced_count = {
            let Monica { repos, github, .. } = &mut *self.m;
            crate::usecases::github::bulk_sync_github(repos, github).await?
        };
        self.m
            .events
            .emit(ApplicationEvent::GithubSyncCompleted { synced_count });
        Ok(synced_count)
    }
}
