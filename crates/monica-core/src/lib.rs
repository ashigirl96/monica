//! Monica core: domain models, use cases, and interface traits.
//!
//! Concrete SQLite, GitHub, Git, filesystem, process, keychain, and runtime wiring live in
//! `monica-infra`.

pub mod domain;
pub mod interfaces;
pub mod shell;
pub mod usecases;

pub use domain::{
    branch_name, is_continuation_session_start, is_safe_task_run_id, is_session_starting_event,
    is_task_notification_prompt, monica_number, parse_issue_input, parse_issue_ref,
    parse_owner_repo, payload_has_running_subagents, subagent_count_update, SubagentCountUpdate,
    transition_is_generic_wait,
    transition_is_protected, wait_reason_for_tool, worktree_path_for, Agent, Artifact,
    ArtifactDraft, ArtifactDraftKind, ArtifactKind, ArtifactState, Attachment, DisplayStatus,
    EssayListItem, Event, BoardColumn, ExternalRef, IntentGroup, IntentListItem, NewArtifact,
    NewDraft, TaskBench, PrepareTaskResult, RunTaskResult, GithubAuthStatus, GithubDeviceFlow,
    GithubIssue, GithubPullRequest, GithubPullRequestRef, GithubPullRequestStatus, HookTransition,
    NewTask, NewTaskRun, PermissionMode, Project, Provider, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncResult, PullRequestSyncStatus, RefType, Task,
    TaskKind, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryRow, TimelineCursor, TimelineItem, board_columns, NewTerminalSession,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
pub use interfaces::{
    ArtifactRepository, AuthGateway, BenchRepository, Clock, EventRepository, GitGateway,
    GithubGateway, ProjectRepository, SetupEnv, SetupOutcome, SetupRunner, TaskRepository,
    TaskRunOutputs, TaskShellEnv, TaskRunRepository, TaskSummaryFilter,
};
pub use usecases::artifact_ops;
pub use usecases::{
    begin_github_device_flow, reconcile_terminal_sessions, DaemonSessionView, ReconcileOutcome,
    TerminalSessionUpdate, close_issue, create_raw_task, execute_run, get_project, github_auth_status,
    list_events, list_projects, list_task_summaries, list_tasks, logout_github,
    make_main_by_terminal_tab, primary_terminal_tab, MakeMainOutcome,
    open_bench, prepare_claude_for_run, record_claude_hook, record_codex_hook, register_project, task_shell_env,
    register_project_with_default_branch, set_project_field, start_run, sync_next_pull_request,
    task_run_settlement_for_orphaned_run, task_run_settlement_for_terminal_exit, TerminalExitSettlement,
    track_github_issue,
    track_github_issue_from_fetched, wait_for_github_device_flow, CloseIssueReport, HookContext,
    HookReport, TrackGithubIssueInput, TrackGithubIssueReport,
};
