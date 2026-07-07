//! Monica application: use cases, ports (interface traits), and the contract/query types that sit
//! just outside the domain — CQRS read models, GitHub adapter DTOs, and hook-lifecycle parsing.
//!
//! Pure aggregates and business rules live in `monica-domain`; concrete SQLite persistence lives in
//! `monica-storage-sqlite`, the GitHub/Git/filesystem/process/keychain/agent adapters in
//! `monica-adapters`, and the composition root in `monica-runtime`.

mod bench;
mod error;
mod events;
mod claude_runtime;
mod execution_profile;
pub mod notification;
pub mod facade;
mod github;
mod input;
mod observation;
pub mod ports;
pub(crate) mod prelude;
mod queries;
pub mod shell;
mod terminal_state;
pub(crate) mod usecases;

pub use error::{ApplicationError, ApplicationResult};
pub use events::{ApplicationEvent, EventSink};
pub use execution_profile::{ExecutionProfile, PermissionMode};
pub use input::parse_issue_input;
pub use facade::{
    Backend, ClaudeSessionDrainOutcome, ExecutionService, Monica, NotebookLintReport,
    NotebookPageView, NotebookService, ProjectInit, ProjectService, SynchronizationService,
    TaskService,
};

pub use ports::{
    AgentDecoders, AgentEventDecoder, ClaudePromptClaim, ClaudeSessionEvent,
    ClaudeSessionObservation, ClaudeSessionRepository, ClaudeToolUse, ClaudeTranscriptReader,
    ClaudeTranscriptRecord,
    ClaudeTranscriptRecordKind, EventRepository, GitGateway,
    NotebookGateway, NotificationOutboxStore, ProjectRepository, PullRequestSyncStore,
    TaskBoardQuery, TaskRunStore, TaskStore, TaskSummaryFilter, TerminalAttachment,
    TerminalCreateRequest, TerminalDaemon, TerminalSessionRepository, TranscriptChunk, UnitOfWork,
    WorkbenchStore, WorkTransaction, Workspace, WorktreeRef,
};

// Application-owned types (NOT in monica-domain)
pub use bench::{bench_runspace_id, PrepareTaskResult, RunTaskResult, TaskBench};
pub use claude_runtime::{
    agent_runtime_runspace_id, claude_jsonl_path, claude_project_slug, ClaudeSessionSpec,
    OpenClaudeSessionParams, MONICA_CLAUDE_SESSION_ID_ENV,
};
pub use github::{
    GithubAuthStatus, GithubDeviceFlow, GithubIssue, GithubPullRequest, GithubPullRequestRef,
    GithubPullRequestStatus, PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate,
    PullRequestSyncResult, PullRequestSyncStatus, RepoPullRequest,
};
pub use observation::TaskRunObservation;
pub use queries::TaskSummaryRow;
pub use terminal_state::{
    TerminalRunspaceKind, TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow,
};

// Usecase result types (returned by facade methods)
pub use usecases::{
    ClaudeHookReport, CloseIssueReport, DaemonSessionView, HookContext, HookReport,
    TerminalSessionUpdate, TrackGithubIssueReport,
};

// Usecase sub-ports (referenced by Backend trait)
pub use usecases::github::ports::{AuthGateway, GithubGateway};
pub use usecases::runs::ports::{
    Clock, SetupEnv, SetupOutcome, SetupRunner, TaskRunOutputs, TaskShellEnv,
};
