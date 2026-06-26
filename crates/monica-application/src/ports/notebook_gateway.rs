use std::path::PathBuf;

use anyhow::Result;

use monica_domain::{LintFinding, NotebookDoc};

/// Filesystem access to notebooks, addressed by slug. The adapter owns path resolution
/// (`$MONICA_HOME/notebooks/<slug>`); the application only deals in slugs and parsed docs. Pure
/// outline / lint logic stays in `monica-domain`.
pub trait NotebookGateway {
    /// `(slug, page_count)` for every notebook, sorted by slug; empty when the root is absent.
    fn page_counts(&self) -> Result<Vec<(String, usize)>>;

    /// Parsed `*.md` pages plus front-matter parse findings for `slug`, or `None` when the
    /// notebook directory does not exist.
    fn read_docs(&self, slug: &str) -> Result<Option<(Vec<NotebookDoc>, Vec<LintFinding>)>>;

    /// Create the notebook directory for `slug` (idempotent); returns its resolved path.
    fn create(&self, slug: &str) -> Result<PathBuf>;
}
