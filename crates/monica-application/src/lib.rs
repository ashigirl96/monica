//! Monica application: use cases, ports (interface traits), and the contract/query types that sit
//! just outside the domain — CQRS read models, GitHub adapter DTOs, and hook-lifecycle parsing.
//!
//! Pure aggregates and business rules live in `monica-domain`; concrete SQLite persistence lives in
//! `monica-storage-sqlite`, the GitHub/Git/filesystem/process/keychain/agent adapters in
//! `monica-adapters`, and the composition root in `monica-runtime`.

mod bench;
mod error;
mod events;
pub mod facade;
mod github;
mod observation;
pub mod ports;
pub mod prelude;
mod queries;
pub mod shell;
mod terminal_state;
pub mod usecases;

pub use error::{ApplicationError, ApplicationResult};
pub use events::{ApplicationEvent, EventSink};
pub use facade::{
    Backend, ExecutionService, Monica, NotebookService, ProjectInit, ProjectService,
    SynchronizationService, TaskService,
};

pub use prelude::{
    branch_name, is_safe_task_run_id,
    front_value, is_valid_slug, mermaid_blocks, monica_number, outline, pages_from_docs,
    parse_front_matter,
    parse_issue_input, parse_issue_ref, parse_owner_repo, parse_wikilink,
    structural_lint,
    AgentSignal, Continuation, LintFinding, NotebookDoc, NotebookPage, OutlineEntry,
    RunObservationPlan, SignalKind,
    transition_is_generic_wait,
    worktree_path_for, Agent, DisplayStatus,
    Event, ExternalIssue, ExternalReference, RawJson,
    TaskBench, PrepareTaskResult, RunTaskResult, GithubAuthStatus, GithubDeviceFlow,
    GithubIssue, GithubPullRequest, GithubPullRequestRef, GithubPullRequestStatus, HookTransition,
    NewTask, NewTaskRun, PermissionMode, Project, Provider, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncResult, PullRequestSyncStatus, RefType, Task,
    TaskKind, TaskRun, TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TaskSummaryRow, NewTerminalSession,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
pub use ports::{
    AgentDecoders, AgentEventDecoder, EventRepository, GitGateway, NotebookGateway,
    ProjectRepository, PullRequestSyncStore, TaskBoardQuery, TaskRunStore, TaskStore,
    TaskSummaryFilter, TerminalAttachment, TerminalCreateRequest, TerminalDaemon,
    TerminalSessionRepository, UnitOfWork, WorkbenchStore, WorkTransaction, Workspace, WorktreeRef,
};
pub use terminal_state::{TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow};
pub use usecases::github::ports::{AuthGateway, GithubGateway};
pub use usecases::runs::ports::{
    Clock, SetupEnv, SetupOutcome, SetupRunner, TaskRunOutputs, TaskShellEnv,
};
pub use usecases::{
    begin_github_device_flow, reconcile_terminal_sessions, DaemonSessionView, ReconcileOutcome,
    TerminalSessionUpdate, close_issue, create_raw_task, execute_run, get_project, github_auth_status,
    list_events, list_projects, list_task_summaries, list_tasks, logout_github,
    make_main_by_terminal_tab, plan_path_for_terminal_tab, primary_terminal_tab, MakeMainOutcome,
    open_bench, prepare_claude_for_run, record_hook, register_project, task_shell_env,
    register_project_with_default_branch, set_project_field, start_run, sync_next_pull_request,
    task_run_settlement_for_orphaned_run, task_run_settlement_for_terminal_exit, TerminalExitSettlement,
    track_github_issue,
    track_github_issue_from_fetched, wait_for_github_device_flow, CloseIssueReport, HookContext,
    HookReport, TrackGithubIssueInput, TrackGithubIssueReport,
};
