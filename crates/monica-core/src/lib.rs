//! Monica core: domain logic shared by the CLI (`monica-cli`) and the Tauri app (`monica-app`).
//! Provides the SQLite-backed store, the `Task` domain model, and `MON-<n>` id allocation.

mod app;
mod claude;
mod db;
mod github;
mod hook;
mod migrations;
mod model;
mod paths;
mod repo;
mod run;
mod store;
#[cfg(test)]
mod test_support;

pub use app::{
    delete_issue, register_project, register_project_with_default_branch, track_github_issue,
    DeleteIssueReport, GithubIssue,
};
pub use claude::AgentLaunch;
pub use db::Db;
pub use github::sync_next_linked_pull_request;
pub use hook::{is_safe_task_run_id, record_claude_hook, status_for_claude_event, HookReport};
pub use model::{
    Agent, DisplayStatus, Event, ExternalRef, GithubPullRequest, GithubPullRequestRef, NewTask,
    NewTaskRun, PermissionMode, Project, Provider, PullRequestStatusSyncCandidate,
    PullRequestSyncCandidate, PullRequestSyncResult, PullRequestSyncStatus, RefType, Task,
    TaskKind, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryRow,
};
pub use paths::{base_dir, db_path, task_run_dir, task_runs_dir, worktrees_dir};
pub use repo::{parse_issue_ref, parse_owner_repo};
pub use run::{
    launch_agent, run_issue, run_issue_with_launch_mode, AgentLaunchMode, SetupOutcome,
    TaskRunReport,
};
