//! Monica core: domain logic shared by the CLI (`monica-cli`) and the Tauri app (`monica-app`).
//! Provides the SQLite-backed store, the `Task` domain model, and `MON-<n>` id allocation.

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
    delete_issue, register_project, register_project_with_default_branch, track_github_issue,
    DeleteIssueReport, GithubIssue,
};
pub use claude::AgentLaunch;
pub use db::Db;
pub use hook::{
    is_safe_task_run_id, record_claude_hook, record_claude_hook_with_session,
    status_for_claude_event, HookReport,
};
pub use model::{
    Agent, AgentSession, AgentSessionStatus, DisplayStatus, Event, ExternalRef, NewAgentSession,
    NewTask, NewTaskRun, PermissionMode, Project, Provider, RefType, Task, TaskKind, TaskRun,
    TaskRunStatus, TaskStatus, TaskSummaryRow,
};
pub use paths::{base_dir, db_path, task_run_dir, task_runs_dir, worktrees_dir};
pub use repo::{parse_issue_ref, parse_owner_repo};
pub use run::{
    launch_agent, run_issue, run_issue_with_session_mode, AgentSessionMode, SetupOutcome,
    TaskRunReport,
};
