//! Monica domain: the innermost layer — business rules and aggregates only.
//!
//! It deliberately depends on nothing but `serde` (derive) and `strum`: no I/O, no `serde_json`,
//! no `anyhow`, no `specta`. UI projections, GitHub-specific contracts, hook-payload parsing, and
//! TypeScript bindings all live in the layers above (`monica-application`, `monica-api`).

mod branch;
mod error;
mod external_ref;
mod json;
mod notebook;
mod project;
mod refs;
mod status;
mod task;
mod task_run;
mod terminal_session;

pub use branch::{branch_name, monica_number, worktree_path_for};
pub use error::DomainError;
pub use external_ref::{ExternalRef, RefType};
pub use json::RawJson;
pub use notebook::{
    front_value, is_valid_slug, mermaid_blocks, outline, pages_from_docs, parse_front_matter,
    parse_wikilink, structural_lint, LintFinding, NotebookDoc, NotebookPage, OutlineEntry,
};
pub use project::{PermissionMode, Project, Provider};
pub use refs::{parse_issue_input, parse_issue_ref, parse_owner_repo};
pub use status::{DisplayStatus, TaskRunStatus, TaskRunWaitReason, TaskStatus};
pub use task::{Event, NewTask, Task, TaskKind};
pub use task_run::{is_safe_task_run_id, Agent, NewTaskRun, TaskRun};
pub use terminal_session::{
    NewTerminalSession, TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
