use anyhow::Result;

use crate::filesystem::{scaffold_monica, FsTaskRunOutputs};
use crate::git::GitCliGateway;
use crate::github::{KeychainAuthGateway, OctocrabGithubGateway};
use crate::process::ProcessSetupRunner;
use crate::sqlite::SqliteStore;

pub struct Runtime {
    pub repositories: SqliteStore,
    pub github: OctocrabGithubGateway,
    pub git: GitCliGateway,
    pub setup_runner: ProcessSetupRunner,
    pub task_run_outputs: FsTaskRunOutputs,
    pub auth: KeychainAuthGateway,
}

impl Runtime {
    pub fn open_default() -> Result<Self> {
        Ok(Self {
            repositories: SqliteStore::open()?,
            github: OctocrabGithubGateway::new(),
            git: GitCliGateway,
            setup_runner: ProcessSetupRunner,
            task_run_outputs: FsTaskRunOutputs,
            auth: KeychainAuthGateway::new(),
        })
    }

    pub fn scaffold_monica(&self, dir: &std::path::Path) -> Result<Vec<(String, bool)>> {
        scaffold_monica(dir)
    }
}
