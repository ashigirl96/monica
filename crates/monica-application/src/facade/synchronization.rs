use super::{Backend, Monica};
use crate::prelude::TaskId;
use crate::usecases::github::{
    GithubSyncReport, LinkPullRequestReport, TrackGithubIssueInput, TrackGithubIssueReport,
};
use crate::{ApplicationEvent, ApplicationResult, GithubAuthStatus, TaskSummaryFilter};

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

    /// User-forced refresh (cmd+r / entering the Workboard / `monica task sync`) — the only GitHub
    /// sync path. Runs the PR pass (repo listings matched to branches, then unresolved refs
    /// re-checked) followed by the issue pass (open tasks' issue titles and states, plus the PRs
    /// that close them), then announces completion. `task` narrows both passes to a single task.
    /// A no-op when GitHub isn't authenticated — the board navigates into a sync on every visit,
    /// and an unauthenticated user must not be nagged for it; callers that need to say so (the CLI,
    /// the desktop command) check [`auth_status`](Self::auth_status) themselves first.
    ///
    /// The report is a diff of the board read model taken around the sync, because no single writer
    /// sees all four fields it covers. A concurrent desktop sync could therefore land inside the
    /// window and be reported here; both write the same GitHub truth, so the worst case is
    /// attributing someone else's refresh to this call.
    pub async fn force_sync_github(
        &mut self,
        task: Option<&TaskId>,
    ) -> ApplicationResult<GithubSyncReport> {
        if !self.auth_status().authenticated {
            return Ok(GithubSyncReport::default());
        }
        let task = task.map(TaskId::as_str);
        let before = self.task_summaries()?;
        let synced_count = {
            let Monica { repos, github, .. } = &mut *self.m;
            crate::usecases::github::bulk_sync_github(repos, github, task).await?
        };
        let after = self.task_summaries()?;
        self.m
            .events
            .emit(ApplicationEvent::GithubSyncCompleted { synced_count });
        Ok(GithubSyncReport {
            synced_count,
            tasks: crate::usecases::github::diff_task_summaries(&before, &after, task),
        })
    }

    fn task_summaries(&self) -> ApplicationResult<Vec<crate::TaskSummaryRow>> {
        crate::usecases::query::list_task_summaries(&self.m.repos, TaskSummaryFilter::All, None)
    }
}
