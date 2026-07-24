//! Monica API: the TypeScript-facing contract layer.
//!
//! Every type that crosses the Tauri boundary lives here as a `specta::Type`-deriving DTO with a
//! `From` conversion from its domain/application counterpart. Consolidating the specta derives in
//! one crate keeps `monica-domain` and `monica-application` free of any TypeScript-binding concern.

mod asset;
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

pub use asset::{Asset as ApiAsset, ImportAsset as ApiImportAsset};
pub use bench::{PrepareTaskResult, RunTaskResult, TaskBench};
pub use error::{ApiError, ApiErrorCode};
pub use explanation::{Explanation as ApiExplanation, ExplanationMode as ApiExplanationMode};
pub use github::GithubPullRequestRef;
pub use link_preview::LinkPreview as ApiLinkPreview;
pub use note::{
    DailyNoteCount as ApiDailyNoteCount, EssayStatus as ApiEssayStatus, Note as ApiNote,
    NoteBlock as ApiNoteBlock, NoteKind as ApiNoteKind, NoteMention as ApiNoteMention,
    NotePage as ApiNotePage, NoteSummary as ApiNoteSummary, NotesToday as ApiNotesToday,
    SetEssayStatus as ApiSetEssayStatus, SetNoteKind as ApiSetNoteKind,
    UpdateNote as ApiUpdateNote,
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
