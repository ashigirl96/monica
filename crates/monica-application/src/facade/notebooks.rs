use std::path::PathBuf;

use super::{Backend, Monica};
use crate::ports::NotebookGateway;
use crate::{is_valid_slug, ApplicationError, ApplicationResult, LintFinding, NotebookDoc};

/// Notebook listing and reads. Outline/lint logic lives in `monica-domain`; this only owns slug
/// validation and existence semantics over the [`NotebookGateway`].
pub struct NotebookService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> NotebookService<'_, B> {
    pub fn list_notebooks(&self) -> ApplicationResult<Vec<(String, usize)>> {
        Ok(self.m.notebooks.page_counts()?)
    }

    /// Parsed pages + front-matter parse findings for a notebook. `Validation` for a malformed
    /// slug, `NotFound` when the notebook directory is absent.
    pub fn read_notebook(&self, slug: &str) -> ApplicationResult<(Vec<NotebookDoc>, Vec<LintFinding>)> {
        if !is_valid_slug(slug) {
            return Err(ApplicationError::validation(format!("invalid notebook id `{slug}`")));
        }
        self.m
            .notebooks
            .read_docs(slug)?
            .ok_or_else(|| ApplicationError::not_found(format!("notebook `{slug}` not found")))
    }

    pub fn create_notebook(&self, slug: &str) -> ApplicationResult<PathBuf> {
        if !is_valid_slug(slug) {
            return Err(ApplicationError::validation(format!(
                "invalid slug `{slug}`: use kebab-case (lowercase a-z, 0-9, single hyphens)"
            )));
        }
        Ok(self.m.notebooks.create(slug)?)
    }
}
