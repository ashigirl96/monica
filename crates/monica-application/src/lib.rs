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
mod input;
mod observation;
pub mod ports;
pub mod prelude;
mod queries;
pub mod shell;
mod terminal_state;
pub mod usecases;

pub use error::{ApplicationError, ApplicationResult};
pub use events::{ApplicationEvent, EventSink};
pub use input::parse_issue_input;
pub use facade::{
    Backend, ExecutionService, Monica, NotebookLintReport, NotebookPageView, NotebookService,
    ProjectInit, ProjectService, SynchronizationService, TaskService,
};

pub use prelude::{
    is_valid_slug, parse_front_matter, parse_owner_repo, transition_is_generic_wait, Agent,
    AgentSignal, Continuation, DisplayStatus, Event, ExternalReference, GithubAuthStatus,
    GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef, GithubPullRequestStatus,
    ExternalIssue, HookTransition, LintFinding, NewTask, NewTaskRun, NewTerminalSession, NotebookDoc,
    PermissionMode, PrepareTaskResult, Project, Provider, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncResult, PullRequestSyncStatus, RawJson, RefType,
    RunTaskResult, SignalKind, Task, TaskBench, TaskId, TaskKind, TaskRun, TaskRunId,
    TaskRunObservation, TaskRunStatus, TaskRunWaitReason, TaskStatus, TaskSummaryRow,
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
    CloseIssueReport, DaemonSessionView, HookContext, HookReport, MakeMainOutcome,
    TerminalSessionUpdate, TrackGithubIssueInput, TrackGithubIssueReport,
};
