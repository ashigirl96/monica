use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};

use monica_application::ports::NotebookGateway;
use monica_domain::{LintFinding, NotebookDoc};

use super::notebook;
use monica_paths as paths;

/// Filesystem-backed [`NotebookGateway`]. Owns slug→path resolution under
/// `$MONICA_HOME/notebooks`, so the application only deals in slugs.
pub struct FsNotebookGateway;

impl NotebookGateway for FsNotebookGateway {
    fn page_counts(&self) -> Result<Vec<(String, usize)>> {
        notebook::notebook_page_counts(&paths::notebooks_dir()?)
    }

    fn read_docs(&self, slug: &str) -> Result<Option<(Vec<NotebookDoc>, Vec<LintFinding>)>> {
        let dir = paths::notebook_dir(slug)?;
        if !dir.is_dir() {
            return Ok(None);
        }
        notebook::read_notebook_docs(&dir).map(Some)
    }

    fn create(&self, slug: &str) -> Result<PathBuf> {
        let dir = paths::notebook_dir(slug)?;
        fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;
        Ok(dir)
    }
}
