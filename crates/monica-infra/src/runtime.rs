use anyhow::Result;

use monica_application::{Backend, EventSink, Monica};

use crate::filesystem::{FsNotebookGateway, FsTaskRunOutputs, FsWorkspace};
use crate::git::GitCliGateway;
use crate::github::{KeychainAuthGateway, OctocrabGithubGateway};
use crate::process::ProcessSetupRunner;
use crate::sqlite::SqliteStore;

/// The concrete adapter set the desktop and CLI run on: SQLite, octocrab, the git CLI, the process
/// setup runner, the filesystem run-output/notebook stores, and the keychain auth gateway.
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
}

/// Open the default application façade, opening the on-disk SQLite store and wiring every adapter.
/// Build one per operation/thread — the façade is `!Send` (it owns a SQLite connection).
pub fn open_monica(events: Box<dyn EventSink>) -> Result<Monica<DefaultBackend>> {
    Ok(Monica::new(
        SqliteStore::open()?,
        GitCliGateway,
        OctocrabGithubGateway::new(),
        KeychainAuthGateway::new(),
        ProcessSetupRunner,
        FsTaskRunOutputs,
        FsNotebookGateway,
        FsWorkspace,
        events,
    ))
}
