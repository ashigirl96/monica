//! Monica core: domain models, use cases, and interface traits.
//!
//! Concrete SQLite, GitHub, Git, filesystem, process, keychain, and runtime wiring live in
//! `monica-infra`.

pub mod domain;
pub mod interfaces;
pub mod usecases;

pub use domain::{
    board_columns, branch_name, is_safe_task_run_id, monica_number, parse_issue_ref,
    parse_owner_repo, should_ignore_claude_event, status_for_claude_event,
    transition_for_claude_event, transition_is_protected, wait_reason_for_tool, worktree_path_for,
    Agent, BoardColumn, DisplayStatus, Event, ExternalRef, GithubAuthStatus, GithubDeviceFlow,
    GithubIssue, GithubPullRequest, GithubPullRequestRef, GithubPullRequestStatus, HookTransition,
    NewTask, NewTaskRun, PermissionMode, Project, Provider, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncCandidate, PullRequestSyncResult,
    PullRequestSyncStatus, RefType, Task, TaskBench, TaskKind, TaskRun, TaskRunObservation,
    TaskRunStatus, TaskRunWaitReason, TaskStatus, TaskSummaryRow,
};
pub use interfaces::{
    AgentLaunch, AgentLaunchMode, AgentLauncher, AuthGateway, BenchRepository, Clock,
    EventRepository, GitGateway, GithubGateway, ProjectRepository, RunArtifacts, SetupEnv,
    SetupOutcome, SetupRunner, TaskRepository, TaskRunRepository,
};
pub use usecases::{
    begin_github_device_flow, delete_issue, finish_issue_run_setup, get_project,
    github_auth_status, launch_agent, list_events, list_projects, list_task_summaries, list_tasks,
    logout_github, mark_issue, open_bench, record_claude_hook, register_project,
    register_project_with_default_branch, run_issue, run_issue_with_launch_mode, set_project_field,
    start_issue_run_setup, sync_next_pull_request, track_github_issue,
    track_github_issue_from_fetched, wait_for_github_device_flow, DeleteIssueReport, HookReport,
    TaskRunReport, TaskRunSetupStartReport, TrackGithubIssueInput, TrackGithubIssueReport,
};
