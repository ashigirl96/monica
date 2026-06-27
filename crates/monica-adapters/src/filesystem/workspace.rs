use std::path::Path;

use anyhow::Result;

use monica_application::ports::Workspace;

use super::scaffold_monica;

/// Filesystem-backed [`Workspace`]: scaffolds `.monica/` from bundled templates.
pub struct FsWorkspace;

impl Workspace for FsWorkspace {
    fn scaffold_monica(&self, dir: &Path) -> Result<Vec<(String, bool)>> {
        scaffold_monica(dir)
    }
}
