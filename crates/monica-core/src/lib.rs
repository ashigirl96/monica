//! Monica core: domain logic shared by the CLI (`monica-cli`) and the Tauri app (`monica-app`).
//! Provides the SQLite-backed store, the `WorkItem` domain model, and `MON-<n>` id allocation.

mod app;
mod claude;
mod db;
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
    register_project, register_project_with_default_branch, track_github_issue, GithubIssue,
};
pub use claude::AgentLaunch;
pub use db::Db;
pub use hook::{is_safe_run_id, record_claude_hook, status_for_claude_event, HookReport};
pub use model::{
    Agent, Event, ExternalRef, IssueStatusRow, NewRun, NewWorkItem, PermissionMode, Project,
    Provider, RefType, Run, Status, WorkItem, WorkItemKind,
};
pub use paths::{base_dir, db_path, run_dir, runs_dir, worktrees_dir};
pub use repo::{parse_issue_ref, parse_owner_repo};
pub use run::{launch_agent, run_issue, RunReport, SetupOutcome};
