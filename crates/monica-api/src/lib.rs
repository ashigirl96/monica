//! Monica API: the TypeScript-facing contract layer.
//!
//! Every type that crosses the Tauri boundary lives here as a `specta::Type`-deriving DTO with a
//! `From` conversion from its domain/application counterpart. Consolidating the specta derives in
//! one crate keeps `monica-domain` and `monica-application` free of any TypeScript-binding concern.

mod bench;
mod error;
mod explanation;
mod github;
mod link_preview;
mod note;
mod settings;
mod status;
mod task;
mod task_run;
mod terminal;

pub use bench::{PrepareTaskResult, RunTaskResult, TaskBench};
pub use error::{ApiError, ApiErrorCode};
pub use explanation::{Explanation as ApiExplanation, ExplanationMode as ApiExplanationMode};
pub use github::GithubPullRequestRef;
pub use link_preview::LinkPreview as ApiLinkPreview;
pub use note::{
    DailyNoteCount as ApiDailyNoteCount, Note as ApiNote, NoteKind as ApiNoteKind,
    NoteMention as ApiNoteMention, NotePage as ApiNotePage, NoteSummary as ApiNoteSummary,
    NotesToday as ApiNotesToday, SetNoteKind as ApiSetNoteKind, UpdateNote as ApiUpdateNote,
};
pub use settings::{
    NotesSettings, TranslateEffort, TranslateModel, TranslateSettings, TranslateSettingsSnapshot,
};
pub use status::{
    board_columns, BoardColumn, DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus,
};
pub use task::{ProjectOption, TaskCreated, TaskSummaryRow};
pub use task_run::Agent;
pub use terminal::{
    TerminalRunspaceRow, TerminalSession, TerminalSessionKind, TerminalSessionStatus,
    TerminalStateSnapshot, TerminalTabRow,
};
