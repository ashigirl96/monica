//! Monica core: domain logic shared by the CLI (`monica-cli`) and the Tauri app (`monica-app`).
//! Provides the SQLite-backed store, the `WorkItem` domain model, and `MON-<n>` id allocation.

mod app;
mod db;
mod migrations;
mod model;
mod paths;
mod repo;
mod run;
mod store;

pub use app::{register_project, track_github_issue, GithubIssue};
pub use db::Db;
pub use model::{
    Agent, Event, ExternalRef, IssueStatusRow, NewRun, NewWorkItem, PermissionMode, Project,
    Provider, RefType, Run, Status, WorkItem, WorkItemKind, DEFAULT_BRANCH_TEMPLATE,
};
pub use paths::{base_dir, db_path, run_dir, runs_dir, worktrees_dir};
pub use repo::{parse_issue_ref, parse_owner_repo};
pub use run::{run_issue, RunReport, SetupOutcome};
