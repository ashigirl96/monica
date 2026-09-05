use super::{Backend, Monica};
use crate::usecases::github::{TrackGithubIssueInput, TrackGithubIssueReport};
use crate::{
    ApplicationEvent, ApplicationError, ApplicationResult, GithubAuthStatus, GithubSyncReport,
    GithubSyncScope,
};

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

    /// Background refresh (cmd+r / entering the Workboard). Unauthenticated is not an error here:
    /// the desktop worker fires on navigation, so it stays quiet rather than nagging.
    pub async fn force_sync_github(&mut self) -> ApplicationResult<u32> {
        if !self.auth_status().authenticated {
            return Ok(0);
        }
        Ok(self.sync_github(GithubSyncScope::All).await?.synced_count)
    }

    /// Explicitly requested refresh (`monica task sync`). Runs the PR pass (repo listings matched
    /// to branches, then unresolved refs re-checked) followed by the issue pass (open tasks' issue
    /// titles and states), then announces completion. Unlike [`Self::force_sync_github`] it fails
    /// loudly when GitHub isn't authenticated: someone asked for this sync and deserves to know it
    /// did nothing.
    pub async fn sync_github(
        &mut self,
        scope: GithubSyncScope,
    ) -> ApplicationResult<GithubSyncReport> {
        let status = self.auth_status();
        if !status.authenticated {
            return Err(ApplicationError::authentication_required(
                status
                    .message
                    .unwrap_or_else(|| "GitHub authentication required".to_string()),
            ));
        }
        let report = {
            let Monica { repos, github, .. } = &mut *self.m;
            crate::usecases::github::bulk_sync_github(repos, github, &scope).await?
        };
        self.m.events.emit(ApplicationEvent::GithubSyncCompleted {
            synced_count: report.synced_count,
        });
        Ok(report)
    }
}
