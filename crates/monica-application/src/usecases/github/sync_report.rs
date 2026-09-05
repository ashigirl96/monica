use std::collections::HashMap;

use crate::github::{GithubIssueState, GithubPullRequestRef, GithubPullRequestStatus};
use crate::queries::TaskSummaryRow;

/// One field a sync moved. The board's read model is the only place where all four live together —
/// the issue title and state come from the ref-state cache, the parent link is rewritten by the
/// issue pass's SQL, and the PR statuses come from the PR pass — so a change report is built by
/// diffing that read model rather than by threading before/after values through three writers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSyncChange {
    Title {
        before: String,
        after: String,
    },
    IssueState {
        before: Option<GithubIssueState>,
        after: Option<GithubIssueState>,
    },
    PullRequest {
        repo: String,
        number: i64,
        before: Option<GithubPullRequestStatus>,
        after: Option<GithubPullRequestStatus>,
    },
    Parent {
        before: Option<String>,
        after: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSyncChanges {
    pub task_id: String,
    pub changes: Vec<TaskSyncChange>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncChangeCounts {
    pub title: usize,
    pub issue_state: usize,
    pub pull_request: usize,
    pub parent: usize,
}

impl SyncChangeCounts {
    pub fn total(self) -> usize {
        self.title + self.issue_state + self.pull_request + self.parent
    }
}

/// What one sync pass wrote, and which repos it could not reach. A pass keeps going when a repo
/// fetch fails — recording an empty success would blank every cached title in that repo over a
/// transient error — so "finished" and "saw everything" are different answers, and the caller has
/// to be able to tell them apart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BulkSyncOutcome {
    pub synced_count: u32,
    pub failed_repos: Vec<String>,
}

impl BulkSyncOutcome {
    pub fn merge(mut self, other: BulkSyncOutcome) -> BulkSyncOutcome {
        self.synced_count += other.synced_count;
        self.failed_repos.extend(other.failed_repos);
        self.failed_repos.sort();
        self.failed_repos.dedup();
        self
    }
}

/// What a forced GitHub sync did: how many refs it wrote, which tasks actually moved, and which
/// repos it never reached.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GithubSyncReport {
    /// Refs the sync wrote, not fields that changed — the number the completion event has always
    /// carried. Use [`GithubSyncReport::change_count`] for "what moved".
    pub synced_count: u32,
    pub tasks: Vec<TaskSyncChanges>,
    /// Repos whose fetch failed. Non-empty means the rest of this report is partial: whatever those
    /// repos own kept its previous value rather than being refreshed.
    pub failed_repos: Vec<String>,
}

impl GithubSyncReport {
    pub fn is_unchanged(&self) -> bool {
        self.tasks.is_empty()
    }

    /// Whether the sync reached every repo it needed. A caller that hands the result to something
    /// downstream — `monica task sync && monica task status` — must not treat a partial sync as
    /// fresh data.
    pub fn is_complete(&self) -> bool {
        self.failed_repos.is_empty()
    }

    pub fn counts(&self) -> SyncChangeCounts {
        let mut counts = SyncChangeCounts::default();
        for change in self.tasks.iter().flat_map(|task| &task.changes) {
            match change {
                TaskSyncChange::Title { .. } => counts.title += 1,
                TaskSyncChange::IssueState { .. } => counts.issue_state += 1,
                TaskSyncChange::PullRequest { .. } => counts.pull_request += 1,
                TaskSyncChange::Parent { .. } => counts.parent += 1,
            }
        }
        counts
    }
}

/// Diff two board snapshots taken around a sync. Only tasks present in both are compared: a sync
/// never creates or deletes a task, so an id on one side alone belongs to a concurrent writer (the
/// desktop worker) and is not this sync's doing. `task` narrows the diff the same way it narrows
/// the sync itself.
pub fn diff_task_summaries(
    before: &[TaskSummaryRow],
    after: &[TaskSummaryRow],
    task: Option<&str>,
) -> Vec<TaskSyncChanges> {
    let previous: HashMap<&str, &TaskSummaryRow> =
        before.iter().map(|row| (row.id.as_str(), row)).collect();

    let mut result = Vec::new();
    for row in after {
        if task.is_some_and(|id| id != row.id) {
            continue;
        }
        let Some(was) = previous.get(row.id.as_str()) else {
            continue;
        };
        let changes = diff_task(was, row);
        if !changes.is_empty() {
            result.push(TaskSyncChanges {
                task_id: row.id.clone(),
                changes,
            });
        }
    }
    result
}

fn diff_task(before: &TaskSummaryRow, after: &TaskSummaryRow) -> Vec<TaskSyncChange> {
    let mut changes = Vec::new();
    if before.title != after.title {
        changes.push(TaskSyncChange::Title {
            before: before.title.clone(),
            after: after.title.clone(),
        });
    }
    if before.github_issue_state != after.github_issue_state {
        changes.push(TaskSyncChange::IssueState {
            before: before.github_issue_state,
            after: after.github_issue_state,
        });
    }
    changes.extend(diff_pull_requests(
        &before.github_pull_requests,
        &after.github_pull_requests,
    ));
    if before.parent_task_id != after.parent_task_id {
        changes.push(TaskSyncChange::Parent {
            before: before.parent_task_id.clone(),
            after: after.parent_task_id.clone(),
        });
    }
    changes
}

/// PRs are matched on `(repo, number)` rather than by position, because a sync appends: the branch
/// pass and the issue reverse lookup can each add a PR the other didn't know about, which shifts
/// every later entry. Only `after` is walked — nothing removes a PR ref, so a key can appear
/// between the snapshots but never disappear.
fn diff_pull_requests(
    before: &[GithubPullRequestRef],
    after: &[GithubPullRequestRef],
) -> Vec<TaskSyncChange> {
    let previous: HashMap<(&str, i64), Option<GithubPullRequestStatus>> =
        before.iter().filter_map(keyed_status).collect();

    after
        .iter()
        .filter_map(keyed_status)
        .filter_map(|((repo, number), status)| {
            let was = previous.get(&(repo, number)).copied().flatten();
            (was != status).then(|| TaskSyncChange::PullRequest {
                repo: repo.to_string(),
                number,
                before: was,
                after: status,
            })
        })
        .collect()
}

/// A ref's identity and status, or `None` for a row too incomplete to compare. Both snapshots read
/// the same column, so the stored spelling compares directly and the key can borrow it — only a
/// change that is actually reported allocates.
fn keyed_status(
    pull_request: &GithubPullRequestRef,
) -> Option<((&str, i64), Option<GithubPullRequestStatus>)> {
    Some((
        (pull_request.repo.as_deref()?, pull_request.number?),
        pull_request.parsed_status(),
    ))
}
