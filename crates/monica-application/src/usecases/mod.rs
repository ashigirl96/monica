pub mod github;
pub mod projects;
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
pub use projects::{
    get_project, list_projects, register_project, register_project_with_default_branch,
    set_project_field,
};
pub use runs::{
    close_issue, execute_run, open_bench, prepare_claude_for_run, record_claude_hook,
    record_codex_hook, start_run, task_shell_env, CloseIssueReport, HookContext, HookReport,
};
pub use tasks::{create_raw_task, list_events, list_task_summaries, list_tasks};
pub use terminal::{
    make_main_by_terminal_tab, plan_path_for_terminal_tab, primary_terminal_tab,
    reconcile_terminal_sessions, task_run_settlement_for_orphaned_run,
    task_run_settlement_for_terminal_exit, DaemonSessionView, MakeMainOutcome, ReconcileOutcome,
    TerminalExitSettlement, TerminalSessionUpdate,
};
