use std::collections::HashMap;
use std::str::FromStr;

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

/// What a forced GitHub sync did: how many refs it wrote, and which tasks actually moved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GithubSyncReport {
    /// Refs the sync wrote, not fields that changed — the number the completion event has always
    /// carried. Use [`GithubSyncReport::change_count`] for "what moved".
    pub synced_count: u32,
    pub tasks: Vec<TaskSyncChanges>,
}

impl GithubSyncReport {
    pub fn is_unchanged(&self) -> bool {
        self.tasks.is_empty()
    }

    pub fn change_count(&self) -> usize {
        self.tasks.iter().map(|task| task.changes.len()).sum()
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

/// PRs are matched on `(repo, number)` rather than by position: the branch pass and the issue
/// reverse lookup both write into the same list, so the order a task's PRs come back in is not
/// stable across a sync.
fn diff_pull_requests(
    before: &[GithubPullRequestRef],
    after: &[GithubPullRequestRef],
) -> Vec<TaskSyncChange> {
    let previous: HashMap<(String, i64), Option<GithubPullRequestStatus>> =
        before.iter().filter_map(keyed_status).collect();
    let current: HashMap<(String, i64), Option<GithubPullRequestStatus>> =
        after.iter().filter_map(keyed_status).collect();

    let mut changes = Vec::new();
    for pull_request in after {
        let Some((key, status)) = keyed_status(pull_request) else {
            continue;
        };
        let was = previous.get(&key).copied().flatten();
        if was != status {
            changes.push(TaskSyncChange::PullRequest {
                repo: key.0,
                number: key.1,
                before: was,
                after: status,
            });
        }
    }
    for pull_request in before {
        let Some((key, status)) = keyed_status(pull_request) else {
            continue;
        };
        if !current.contains_key(&key) {
            changes.push(TaskSyncChange::PullRequest {
                repo: key.0,
                number: key.1,
                before: status,
                after: None,
            });
        }
    }
    changes
}

fn keyed_status(
    pull_request: &GithubPullRequestRef,
) -> Option<((String, i64), Option<GithubPullRequestStatus>)> {
    let repo = pull_request.repo.as_deref()?.to_ascii_lowercase();
    let number = pull_request.number?;
    let status = pull_request
        .status
        .as_deref()
        .and_then(|s| GithubPullRequestStatus::from_str(s).ok());
    Some(((repo, number), status))
}
