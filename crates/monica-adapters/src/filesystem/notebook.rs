use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

use monica_application::{is_valid_slug, parse_front_matter, LintFinding, NotebookDoc};

/// Sorted `*.md` paths in a notebook directory. Per-entry `read_dir` errors are propagated, not
/// dropped, so callers never silently skip an unreadable page.
pub fn md_paths(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut paths: Vec<_> = fs::read_dir(dir)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .collect();
    paths.sort();
    Ok(paths)
}

/// Reads a notebook directory's `*.md` pages into docs. A file whose front matter fails to parse
/// becomes a finding instead of a doc, so one malformed page never aborts the whole read. Dir
/// resolution and existence checks are the caller's responsibility.
pub fn read_notebook_docs(dir: &Path) -> Result<(Vec<NotebookDoc>, Vec<LintFinding>)> {
    let mut docs = Vec::new();
    let mut findings = Vec::new();
    for path in md_paths(dir)? {
        let file = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let content = fs::read_to_string(&path)?;
        match parse_front_matter(&content) {
            Ok((front, body)) => docs.push(NotebookDoc { file, stem, front, body }),
            Err(message) => findings.push(LintFinding { file, message }),
        }
    }
    Ok((docs, findings))
}

/// `(slug, page_count)` for each notebook directory directly under `root`, sorted by slug. Only
/// ASCII kebab-case names — what `monica notebooks new` creates — count as notebooks; `page_count`
/// is the number of `*.md` pages. A missing `root` yields an empty list rather than an error.
pub fn notebook_page_counts(root: &Path) -> Result<Vec<(String, usize)>> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut notebooks = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().into_owned();
        if !is_valid_slug(&slug) {
            continue;
        }
        notebooks.push((slug, md_paths(&entry.path())?.len()));
    }
    notebooks.sort();
    Ok(notebooks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Tmp;

    fn write(dir: &Path, name: &str, contents: &str) {
        fs::write(dir.join(name), contents).unwrap();
    }

    #[test]
    fn md_paths_lists_only_md_sorted() {
        let tmp = Tmp::new("notebook-md-paths");
        write(tmp.path(), "step-2.md", "");
        write(tmp.path(), "step-1.md", "");
        write(tmp.path(), "notes.txt", "");
        let names: Vec<String> = md_paths(tmp.path())
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap_or_default().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["step-1.md", "step-2.md"]);
    }

    #[test]
    fn read_notebook_docs_parses_docs_and_collects_findings() {
        let tmp = Tmp::new("notebook-read-docs");
        write(
            tmp.path(),
            "step-1.md",
            "---\ntitle: One\norder: 1\nparent:\ncreated: 2026-06-25T10:00:00Z\n---\nbody one\n",
        );
        write(tmp.path(), "broken.md", "---\ntitle: Broken\n");
        write(tmp.path(), "ignore.txt", "not markdown");

        let (docs, findings) = read_notebook_docs(tmp.path()).unwrap();

        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].stem, "step-1");
        assert_eq!(docs[0].file, "step-1.md");
        assert_eq!(docs[0].body, "body one\n");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].file, "broken.md");
    }

    #[test]
    fn read_notebook_docs_empty_dir_yields_nothing() {
        let tmp = Tmp::new("notebook-empty");
        let (docs, findings) = read_notebook_docs(tmp.path()).unwrap();
        assert!(docs.is_empty());
        assert!(findings.is_empty());
    }

    #[test]
    fn notebook_page_counts_skips_non_slug_dirs_and_files() {
        let tmp = Tmp::new("notebook-page-counts");
        let root = tmp.path();
        fs::create_dir(root.join("rust-async")).unwrap();
        write(&root.join("rust-async"), "step-1.md", "");
        write(&root.join("rust-async"), "step-2.md", "");
        fs::create_dir(root.join("intro")).unwrap();
        write(&root.join("intro"), "step-1.md", "");
        fs::create_dir(root.join("Not_Valid")).unwrap();
        write(root, "loose.md", "");

        let counts = notebook_page_counts(root).unwrap();
        assert_eq!(counts, vec![("intro".to_string(), 1), ("rust-async".to_string(), 2)]);
    }

    #[test]
    fn notebook_page_counts_missing_root_is_empty() {
        let tmp = Tmp::new("notebook-page-counts-missing");
        assert!(notebook_page_counts(&tmp.path().join("does-not-exist")).unwrap().is_empty());
    }
}
