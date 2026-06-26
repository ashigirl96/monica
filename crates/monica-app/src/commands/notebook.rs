use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

use monica_application::{front_value, is_valid_slug, outline, pages_from_docs, NotebookDoc, NotebookPage};
use monica_infra::filesystem::{notebook, paths};

#[derive(Serialize, specta::Type)]
pub struct NotebookSummary {
    pub id: String,
    pub title: String,
    pub page_count: u32,
}

#[derive(Serialize, specta::Type)]
pub struct NotebookPageRow {
    pub id: String,
    pub title: String,
    /// Outline number (`1`, `1.1`, …) — the page's place in the document tree.
    pub number: String,
    /// Raw `created` front matter value (ISO 8601), if present.
    pub created: Option<String>,
    /// Page body (front matter stripped) — the markdown source.
    pub body: String,
}

#[tauri::command]
#[specta::specta]
pub fn list_notebooks() -> Result<Vec<NotebookSummary>, String> {
    let root = paths::notebooks_dir().map_err(|e| e.to_string())?;
    let counts = notebook::notebook_page_counts(&root).map_err(|e| e.to_string())?;
    Ok(counts
        .into_iter()
        .map(|(slug, count)| {
            let title = deslugify(&slug);
            NotebookSummary {
                id: slug,
                title,
                page_count: u32::try_from(count).unwrap_or(u32::MAX),
            }
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn get_notebook_pages(notebook_id: String) -> Result<Vec<NotebookPageRow>, String> {
    let dir = notebook_dir_checked(&notebook_id)?;
    let (docs, _) = notebook::read_notebook_docs(&dir).map_err(|e| e.to_string())?;
    Ok(build_page_rows(&docs))
}

/// Rejects ids holding `/`, `\`, `..` or anything outside ASCII kebab-case, so a resolved read
/// can never escape `notebooks_dir()`.
fn notebook_dir_checked(notebook_id: &str) -> Result<PathBuf, String> {
    if !is_valid_slug(notebook_id) {
        return Err(format!("invalid notebook id `{notebook_id}`"));
    }
    paths::notebook_dir(notebook_id).map_err(|e| e.to_string())
}

/// Presentation-only display title from a slug: `rust-async` -> `Rust Async`.
fn deslugify(slug: &str) -> String {
    let mut title = String::with_capacity(slug.len());
    for seg in slug.split('-').filter(|seg| !seg.is_empty()) {
        if !title.is_empty() {
            title.push(' ');
        }
        let mut chars = seg.chars();
        if let Some(first) = chars.next() {
            title.extend(first.to_uppercase());
            title.push_str(chars.as_str());
        }
    }
    title
}

/// Pages in `outline()` document order (depth-first): each carries its hierarchical number,
/// `created`, and body. Pages the outline omits (e.g. trapped in a `parent` cycle) are dropped,
/// matching the CLI's `show`.
fn build_page_rows(docs: &[NotebookDoc]) -> Vec<NotebookPageRow> {
    let pages: Vec<NotebookPage> = pages_from_docs(docs);
    let by_stem: HashMap<&str, &NotebookDoc> = docs.iter().map(|d| (d.stem.as_str(), d)).collect();
    outline(&pages)
        .into_iter()
        .map(|e| {
            let doc = by_stem.get(e.id.as_str());
            NotebookPageRow {
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

    #[test]
    fn deslugify_capitalizes_each_segment() {
        assert_eq!(deslugify("rust-async"), "Rust Async");
        assert_eq!(deslugify("step-by-step-guide"), "Step By Step Guide");
    }

    #[test]
    fn deslugify_single_word_and_digits() {
        assert_eq!(deslugify("overview"), "Overview");
        assert_eq!(deslugify("step-1"), "Step 1");
        assert_eq!(deslugify("2024-recap"), "2024 Recap");
    }

    #[test]
    fn deslugify_empty_is_empty() {
        assert_eq!(deslugify(""), "");
    }

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
    fn build_page_rows_numbers_in_outline_order_with_created_and_body() {
        let docs = vec![
            doc("s1", "2", "", "2026-06-25T10:00:00Z", "body one"),
            doc("s2", "1", "", "", "body two"),
            doc("s1c", "1", "s1", "2026-06-25T11:00:00Z", "child body"),
        ];
        let rows = build_page_rows(&docs);
        let got: Vec<(&str, &str, Option<&str>, &str)> = rows
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
