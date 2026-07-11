//! Monica domain: the innermost layer — business rules and aggregates only.
//!
//! It deliberately depends on nothing but `serde` (derive) and `strum`: no I/O, no `serde_json`,
//! no `anyhow`, no `specta`. UI projections, GitHub-specific contracts, hook-payload parsing, and
//! TypeScript bindings all live in the layers above (`monica-application`, `monica-api`).

mod agent_signal;
mod branch;
mod error;
mod explanation;
mod external_reference;
mod ids;
mod json;
mod notification;
mod project;
mod refs;
mod status;
mod task;
mod task_run;
mod terminal_session;

pub use agent_signal::{
    transition_is_generic_wait, AgentSignal, Continuation, HookTransition, RunObservationPlan,
    SignalKind,
};
pub use branch::{branch_name, monica_number, worktree_path_for};
pub use error::DomainError;
pub use explanation::{
    is_safe_explanation_id, Explanation, ExplanationMode, NewExplanation,
};
pub use external_reference::{ExternalIssue, ExternalReference, RefType};
pub use ids::{TaskId, TaskRunId};
pub use json::RawJson;
pub use notification::{NewNotificationIntent, NotificationIntent, NotificationKind};
pub use project::{Project, Provider};
pub use refs::{parse_issue_number, parse_issue_ref, parse_owner_repo};
pub use status::{DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus};
pub use task::{Event, NewTask, Task, TaskKind};
pub use task_run::{is_safe_task_run_id, Agent, NewTaskRun, TaskRun};
pub use terminal_session::{
    AgentSessionEffect, AgentSessionStatus, NewTerminalSession, ProviderSessionBinding,
    ProviderSessionEvent, TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
