use std::path::Path;

use anyhow::Result;

/// Project-workspace filesystem operations (the `.monica/` scaffold). Separate from `GitGateway`
/// because it writes Monica's own files, not git state.
pub trait Workspace {
    /// Scaffold `.monica/` (setup.sh, prompt.md) under `dir`; returns `(relative path, created)`
    /// per file, where `created` is false when the file already existed.
    fn scaffold_monica(&self, dir: &Path) -> Result<Vec<(String, bool)>>;
}
