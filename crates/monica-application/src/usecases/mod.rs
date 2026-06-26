pub mod github;
pub mod projects;
pub mod query;
pub mod runs;
pub mod tasks;
pub mod terminal;

#[cfg(test)]
mod tests;

pub use github::{
    begin_github_device_flow, github_auth_status, logout_github, sync_next_pull_request,
    track_github_issue, track_github_issue_from_fetched, wait_for_github_device_flow,
    TrackGithubIssueInput, TrackGithubIssueReport,
};
pub use projects::{register_project, register_project_with_default_branch};
pub use query::{
    get_project, list_events, list_projects, list_task_summaries, list_tasks,
    plan_path_for_terminal_tab, set_project_field,
};
pub use runs::{
    execute_run, open_bench, prepare_claude_for_run, record_claude_hook, record_codex_hook,
    start_run, task_shell_env, HookContext, HookReport,
};
pub use tasks::{
    close_issue, create_raw_task, make_main_by_terminal_tab, primary_terminal_tab,
    CloseIssueReport, MakeMainOutcome,
};
pub use terminal::{
    reconcile_terminal_sessions, task_run_settlement_for_orphaned_run,
    task_run_settlement_for_terminal_exit, DaemonSessionView, ReconcileOutcome,
    TerminalExitSettlement, TerminalSessionUpdate,
};
