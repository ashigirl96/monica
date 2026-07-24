//! Monica domain: the innermost layer — business rules and aggregates only.
//!
//! It deliberately depends on nothing but `serde` (derive), `serde_json`, and `strum`: no I/O,
//! no `anyhow`, no `specta`. `serde_json` is admitted solely for the note-doc model (`note_doc`),
//! whose `Unknown` variants must carry unrecognized JSON through unchanged. UI projections,
//! GitHub-specific contracts, hook-payload parsing, and TypeScript bindings all live in the
//! layers above (`monica-application`, `monica-api`).

mod agent_signal;
mod branch;
mod error;
mod explanation;
mod external_reference;
mod ids;
mod json;
mod note;
mod note_doc;
mod note_markdown;
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
pub use explanation::{Explanation, ExplanationMode, NewExplanation, repo_name_from_cwd};
pub use external_reference::{ExternalIssue, ExternalReference, RefType};
pub use ids::{ExplanationId, NoteId, TaskId, TaskRunId};
pub use json::RawJson;
pub use note::{
    is_valid_date, logical_date, DailyNoteCount, EssayStatus, EssayStatusError,
    KindTransitionError, Note, NoteKind, NoteKindTarget, NotePage, NoteSummary, UpdateNote,
    EMPTY_NOTE_DOC,
};
pub use note_doc::{
    block_subtree, first_line_preview, plain_text, BlockContainerAttrs, BlockNode, BookmarkAttrs,
    CalloutAttrs, CodeBlockAttrs, DocNode, HeadingAttrs, ImageAttrs, InlineNode, LinkMarkAttrs,
    LinkMentionAttrs, Mark, NoteMentionAttrs, NumberedAttrs, SyncedBlockAttrs, TodoAttrs,
    ToggleAttrs,
};
pub use note_markdown::{to_markdown, NoteDocResolver, SyncedBlockMode};
pub use notification::{NewNotificationIntent, NotificationIntent, NotificationKind};
pub use project::{Project, Provider};
pub use refs::{github_issue_url, parse_issue_number, parse_issue_ref, parse_owner_repo};
pub use status::{DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus};
pub use task::{Event, NewTask, Task, TaskKind};
pub use task_run::{is_safe_task_run_id, Agent, NewTaskRun, TaskRun};
pub use terminal_session::{
    AgentSessionEffect, AgentSessionStatus, NewTerminalSession, TerminalSession,
    TerminalSessionKind, TerminalSessionStatus,
};
