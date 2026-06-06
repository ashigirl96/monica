pub mod auth;
pub mod delete_issue;
pub mod query;
pub mod record_claude_hook;
pub mod register_project;
pub mod run_issue;
pub mod sync_pull_requests;
#[cfg(test)]
mod tests;
pub mod track_github_issue;

pub use auth::{
    begin_github_device_flow, github_auth_status, logout_github, wait_for_github_device_flow,
};
pub use delete_issue::{delete_issue, DeleteIssueReport};
pub use query::{
    get_project, list_events, list_projects, list_task_summaries, list_tasks, mark_issue,
    set_project_field,
};
pub use record_claude_hook::{record_claude_hook, HookReport};
pub use register_project::{register_project, register_project_with_default_branch};
pub use run_issue::{launch_agent, run_issue, run_issue_with_launch_mode, TaskRunReport};
pub use sync_pull_requests::sync_next_pull_request;
pub use track_github_issue::{
    track_github_issue, track_github_issue_from_fetched, TrackGithubIssueInput,
    TrackGithubIssueReport,
};
