//! Monica core: domain logic shared by the CLI (`monica-cli`) and the Tauri app (`monica-app`).
//! Provides the SQLite-backed store, the `WorkItem` domain model, and `MON-<n>` id allocation.

mod db;
mod migrations;
mod model;
mod paths;
mod store;

pub use db::Db;
pub use model::{
    Agent, Event, ExternalRef, NewWorkItem, PermissionMode, Project, Provider, RefType, Run, Status,
    WorkItem, WorkItemKind, DEFAULT_BRANCH_TEMPLATE,
};
pub use paths::{base_dir, db_path, runs_dir};
