pub mod auth;
pub mod open_bench;
pub mod delete_issue;
pub mod make_main;
pub mod query;
pub mod reconcile_terminal_sessions;
pub mod record_claude_hook;
pub mod register_project;
pub mod run_task;
pub mod sync_pull_requests;
#[cfg(test)]
mod tests;
pub mod track_github_issue;

pub use auth::{
    begin_github_device_flow, github_auth_status, logout_github, wait_for_github_device_flow,
};
pub use open_bench::{open_bench, task_shell_env};
pub use delete_issue::{delete_issue, DeleteIssueReport};
pub use make_main::{make_main_by_terminal_tab, primary_terminal_tab, MakeMainOutcome};
pub use query::{
    get_project, list_events, list_projects, list_task_summaries, list_tasks, mark_issue,
    set_project_field,
};
pub use reconcile_terminal_sessions::{
    reconcile_terminal_sessions, DaemonSessionView, ReconcileOutcome, TerminalSessionUpdate,
};
pub use record_claude_hook::{record_claude_hook, HookContext, HookReport};
pub use register_project::{register_project, register_project_with_default_branch};
pub use run_task::{execute_run, prepare_claude_for_run, start_run};
pub use sync_pull_requests::sync_next_pull_request;
pub use track_github_issue::{
    track_github_issue, track_github_issue_from_fetched, TrackGithubIssueInput,
    TrackGithubIssueReport,
};
