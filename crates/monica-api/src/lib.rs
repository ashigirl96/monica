//! Monica API: the TypeScript-facing contract layer.
//!
//! Every type that crosses the Tauri boundary lives here as a `specta::Type`-deriving DTO with a
//! `From` conversion from its domain/application counterpart. Consolidating the specta derives in
//! one crate keeps `monica-domain` and `monica-application` free of any TypeScript-binding concern.

mod bench;
mod error;
mod github;
mod status;
mod task;
mod task_run;
mod terminal;

pub use bench::{PrepareTaskResult, RunTaskResult, TaskBench};
pub use error::{ApiError, ApiErrorCode};
pub use github::GithubPullRequestRef;
pub use status::{
    board_columns, BoardColumn, DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus,
};
pub use task::{ProjectOption, TaskCreated, TaskSummaryRow};
pub use task_run::Agent;
pub use terminal::{
    TerminalRunspaceRow, TerminalSession, TerminalSessionKind, TerminalSessionStatus,
    TerminalStateSnapshot, TerminalTabRow,
};
