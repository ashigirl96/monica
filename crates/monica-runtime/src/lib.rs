//! Monica's composition root: the one place that names every concrete adapter and wires them into
//! the [`Monica`] façade. Drivers (desktop, CLI) depend on this crate and reach the application
//! only through [`open_monica`]/[`MonicaFacade`] — they never name a concrete store or gateway.

use std::path::Path;

use anyhow::Result;

use monica_adapters::agents::DefaultAgentDecoders;
use monica_adapters::filesystem::{FsNotebookGateway, FsTaskRunOutputs, FsWorkspace};
use monica_adapters::git::GitCliGateway;
use monica_adapters::github::{KeychainAuthGateway, OctocrabGithubGateway};
use monica_adapters::process::ProcessSetupRunner;
use monica_application::{Backend, EventSink, Monica, WorktreeRef};
use monica_storage_sqlite::SqliteStore;

pub mod notification_drain;
pub mod pr_sync;

pub use notification_drain::{start_notification_drain, NotificationDrainHandle};
pub use pr_sync::{start_pr_sync, PrSyncWaker};

/// The concrete adapter set the desktop and CLI run on: SQLite, octocrab, the git CLI, the process
/// setup runner, the filesystem run-output/notebook stores, the keychain auth gateway, and the
/// agent hook decoders.
pub struct DefaultBackend;

impl Backend for DefaultBackend {
    type Repos = SqliteStore;
    type Git = GitCliGateway;
    type Github = OctocrabGithubGateway;
    type Auth = KeychainAuthGateway;
    type Setup = ProcessSetupRunner;
    type Outputs = FsTaskRunOutputs;
    type Notebooks = FsNotebookGateway;
    type Workspace = FsWorkspace;
    type Agents = DefaultAgentDecoders;
}

/// The application façade wired to the default backend. Drivers alias this rather than naming the
/// concrete adapters that back it.
pub type MonicaFacade = Monica<DefaultBackend>;

/// Open the default application façade, opening the on-disk SQLite store and wiring every adapter.
/// Build one per operation/thread — the façade is `!Send` (it owns a SQLite connection).
pub fn open_monica(events: Box<dyn EventSink>) -> Result<MonicaFacade> {
    Ok(Monica::new(
        SqliteStore::open()?,
        GitCliGateway,
        OctocrabGithubGateway::new(),
        KeychainAuthGateway::new(),
        ProcessSetupRunner,
        FsTaskRunOutputs,
        FsNotebookGateway,
        FsWorkspace,
        DefaultAgentDecoders,
        events,
    ))
}

/// The repo/branch `cwd` belongs to when inside a linked worktree; `None` for the main checkout. A
/// pure git query, so it opens no store — drivers reach it here rather than naming the git adapter.
pub fn worktree_info(cwd: &Path) -> Option<WorktreeRef> {
    monica_adapters::git::worktree_info(cwd)
}
