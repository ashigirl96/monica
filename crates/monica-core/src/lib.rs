//! Monica core: domain models, use cases, and interface traits.
//!
//! Concrete SQLite, GitHub, Git, filesystem, process, keychain, and runtime wiring live in
//! `monica-infra`.

pub mod domain;
pub mod interfaces;
pub mod usecases;

pub use domain::{
    branch_name, is_safe_task_run_id, monica_number, parse_issue_ref, parse_owner_repo,
    should_ignore_claude_event, status_for_claude_event, transition_for_claude_event,
    transition_is_protected, wait_reason_for_tool, worktree_path_for, Agent, DisplayStatus, Event,
    BoardColumn, ExternalRef, TaskBench, PrepareTaskResult, RunTaskResult, GithubAuthStatus, GithubDeviceFlow, GithubIssue, GithubPullRequest,
    GithubPullRequestRef, GithubPullRequestStatus, HookTransition, NewTask, NewTaskRun,
    PermissionMode, Project, Provider, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncResult,
    PullRequestSyncStatus, RefType, Task, TaskKind, TaskRun, TaskRunObservation, TaskRunStatus,
    TaskRunWaitReason, TaskStatus, TaskSummaryRow, board_columns, NewTerminalSession,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
pub use interfaces::{
    AuthGateway, BenchRepository, Clock, EventRepository, GitGateway, GithubGateway,
    ProjectRepository, RunArtifacts, SetupEnv, SetupOutcome, SetupRunner, TaskRepository,
    TaskShellEnv,
    TaskRunRepository,
};
pub use usecases::{
    begin_github_device_flow, reconcile_terminal_sessions, DaemonSessionView, ReconcileOutcome,
    TerminalSessionUpdate, delete_issue, execute_run, get_project, github_auth_status,
    list_events, list_projects, list_task_summaries, list_tasks, logout_github,
    make_main_by_terminal_tab, mark_issue, primary_terminal_tab, MakeMainOutcome,
    open_bench, prepare_claude_for_run, record_claude_hook, register_project, task_shell_env,
    register_project_with_default_branch, set_project_field, start_run, sync_next_pull_request,
    track_github_issue,
    track_github_issue_from_fetched, wait_for_github_device_flow, DeleteIssueReport, HookContext,
    HookReport, TrackGithubIssueInput, TrackGithubIssueReport,
};
