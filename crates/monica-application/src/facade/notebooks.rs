use std::collections::HashMap;
use std::path::PathBuf;

use super::{Backend, Monica};
use crate::ports::NotebookGateway;
use crate::prelude::{front_value, mermaid_blocks, outline, pages_from_docs, structural_lint};
use crate::prelude::{is_valid_slug, LintFinding, NotebookDoc};
use crate::{ApplicationError, ApplicationResult};

/// A notebook page projected for display: outline number plus the page's `created` front-matter and
/// body. Document order (depth-first); pages the outline omits (e.g. trapped in a `parent` cycle)
/// are dropped.
pub struct NotebookPageView {
    pub id: String,
    pub title: String,
    pub number: String,
    pub created: Option<String>,
    pub body: String,
}

/// The domain-computed half of a notebook lint. Mermaid-diagram and markdown-style validation pull
/// in CLI-only toolchains, so they stay driver-side: this carries the parsed `docs` and the raw
/// mermaid blocks per file for the driver to validate, alongside the findings the domain owns.
pub struct NotebookLintReport {
    /// Front-matter parse findings (from the read) plus structural-lint findings — both fatal.
    pub findings: Vec<LintFinding>,
    /// `(file, mermaid block bodies)` per doc, for the driver's diagram validator.
    pub mermaid_blocks_by_file: Vec<(String, Vec<String>)>,
    pub docs: Vec<NotebookDoc>,
}

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

    /// The notebook's pages in outline order, each carrying its hierarchical number, `created`, and
    /// body — everything a driver needs to render the page tree without touching domain logic.
    pub fn page_outline(&self, slug: &str) -> ApplicationResult<Vec<NotebookPageView>> {
        let (docs, _) = self.read_notebook(slug)?;
        Ok(page_views(&docs))
    }

    /// Lint a notebook: returns the domain-owned findings plus the raw material (parsed docs, per-file
    /// mermaid blocks) a driver needs to run its own diagram/style validators.
    pub fn notebook_lint(&self, slug: &str) -> ApplicationResult<NotebookLintReport> {
        let (docs, mut findings) = self.read_notebook(slug)?;
        findings.extend(structural_lint(&docs));
        let mermaid_blocks_by_file = docs
            .iter()
            .map(|doc| (doc.file.clone(), mermaid_blocks(&doc.body)))
            .collect();
        Ok(NotebookLintReport { findings, mermaid_blocks_by_file, docs })
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

fn page_views(docs: &[NotebookDoc]) -> Vec<NotebookPageView> {
    let pages = pages_from_docs(docs);
    let by_stem: HashMap<&str, &NotebookDoc> = docs.iter().map(|d| (d.stem.as_str(), d)).collect();
    outline(&pages)
        .into_iter()
        .map(|e| {
            let doc = by_stem.get(e.id.as_str());
            NotebookPageView {
                created: doc.and_then(|d| front_value(d, "created")).map(str::to_string),
                body: doc.map(|d| d.body.clone()).unwrap_or_default(),
                id: e.id,
                title: e.title,
                number: e.number,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(stem: &str, order: &str, parent: &str, created: &str, body: &str) -> NotebookDoc {
        let mut front = vec![
            ("title".to_string(), stem.to_uppercase()),
            ("order".to_string(), order.to_string()),
        ];
        if !parent.is_empty() {
            front.push(("parent".to_string(), format!("[[{parent}.md]]")));
        }
        if !created.is_empty() {
            front.push(("created".to_string(), created.to_string()));
        }
        NotebookDoc {
            file: format!("{stem}.md"),
            stem: stem.to_string(),
            front,
            body: body.to_string(),
        }
    }

    #[test]
    fn page_views_number_in_outline_order_with_created_and_body() {
        let docs = vec![
            doc("s1", "2", "", "2026-06-25T10:00:00Z", "body one"),
            doc("s2", "1", "", "", "body two"),
            doc("s1c", "1", "s1", "2026-06-25T11:00:00Z", "child body"),
        ];
        let pages = page_views(&docs);
        let got: Vec<(&str, &str, Option<&str>, &str)> = pages
            .iter()
            .map(|r| (r.id.as_str(), r.number.as_str(), r.created.as_deref(), r.body.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("s2", "1", None, "body two"),
                ("s1", "2", Some("2026-06-25T10:00:00Z"), "body one"),
                ("s1c", "2.1", Some("2026-06-25T11:00:00Z"), "child body"),
            ]
        );
    }
}
