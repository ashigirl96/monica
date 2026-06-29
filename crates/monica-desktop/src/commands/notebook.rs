use monica_api::ApiError;
use monica_application::NotebookPageView;
use serde::Serialize;
use tauri::AppHandle;

use crate::event_sink;

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

impl From<NotebookPageView> for NotebookPageRow {
    fn from(view: NotebookPageView) -> Self {
        Self {
            id: view.id,
            title: view.title,
            number: view.number,
            created: view.created,
            body: view.body,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_notebooks(app: AppHandle) -> Result<Vec<NotebookSummary>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .notebooks()
            .list_notebooks()?
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
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_notebook_pages(
    app: AppHandle,
    notebook_id: String,
) -> Result<Vec<NotebookPageRow>, ApiError> {
    event_sink::off_main(move || {
        let mut monica = event_sink::open(&app)?;
        Ok(monica
            .notebooks()
            .page_outline(&notebook_id)?
            .into_iter()
            .map(NotebookPageRow::from)
            .collect())
    })
    .await
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
}
