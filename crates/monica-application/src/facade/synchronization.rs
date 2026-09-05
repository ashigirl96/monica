use super::{Backend, Monica};
use crate::ports::TaskStore;
use crate::prelude::TaskId;
use crate::usecases::github::{
    BulkSyncOutcome, GithubSyncReport, LinkPullRequestReport, TrackGithubIssueInput,
    TrackGithubIssueReport,
};
use crate::{ApplicationError, ApplicationEvent, ApplicationResult, GithubAuthStatus};

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
    pub async fn force_sync_github(&mut self, task: Option<&TaskId>) -> ApplicationResult<u32> {
        self.ensure_task_exists(task)?;
        if !self.auth_status().authenticated {
            return Ok(0);
        }
        Ok(self.run_sync(task.map(TaskId::as_str)).await?.synced_count)
    }

    /// [`force_sync_github`](Self::force_sync_github) plus a report of what moved, for a caller that
    /// shows the diff rather than the refreshed board — `monica task sync`.
    ///
    /// The diff comes from two reads of the board read model taken around the sync, because no
    /// single writer sees all four fields it covers. That costs a board read on each side, so the
    /// board's own refresh deliberately does not come through here. A concurrent desktop sync can
    /// land inside the window and be reported here; both write the same GitHub truth, so the worst
    /// case is attributing someone else's refresh to this call.
    pub async fn sync_github_with_report(
        &mut self,
        task: Option<&TaskId>,
    ) -> ApplicationResult<GithubSyncReport> {
        self.ensure_task_exists(task)?;
        if !self.auth_status().authenticated {
            return Ok(GithubSyncReport::default());
        }
        let task = task.map(TaskId::as_str);
        // The same read model the board and `monica task status` show, so "what changed" is
        // literally what a reader would have seen change.
        let before = self.m.tasks().list_all_task_summaries(None)?;
        let outcome = self.run_sync(task).await?;
        let after = self.m.tasks().list_all_task_summaries(None)?;
        Ok(GithubSyncReport {
            synced_count: outcome.synced_count,
            tasks: crate::usecases::github::diff_task_summaries(&before, &after, task),
            failed_repos: outcome.failed_repos,
        })
    }

    async fn run_sync(&mut self, task: Option<&str>) -> ApplicationResult<BulkSyncOutcome> {
        let outcome = {
            let Monica { repos, github, .. } = &mut *self.m;
            crate::usecases::github::bulk_sync_github(repos, github, task).await?
        };
        self.m.events.emit(ApplicationEvent::GithubSyncCompleted {
            synced_count: outcome.synced_count,
        });
        Ok(outcome)
    }

    /// Naming a task that does not exist is a mistake worth reporting, not a sync that quietly
    /// covers nothing — and every driver gets the same answer by asking here.
    fn ensure_task_exists(&self, task: Option<&TaskId>) -> ApplicationResult<()> {
        match task {
            Some(task_id) if self.m.repos.get_task(task_id)?.is_none() => Err(
                ApplicationError::not_found(format!("task not found: {task_id}")),
            ),
            _ => Ok(()),
        }
    }
}
