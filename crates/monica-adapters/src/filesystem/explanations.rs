use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use monica_paths as paths;

pub fn remove_explanation_dir(id: &str) -> Result<()> {
    let dir = paths::explanation_dir(id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("failed to remove {}", dir.display())),
    }
}

pub fn write_explanation_scaffold(id: &str, title: &str) -> Result<PathBuf> {
    let dir = paths::explanation_dir(id)?;
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create {}", dir.display()))?;

    let index_path = paths::explanation_index_path(id)?;
    let html = scaffold_html(title);
    fs::write(&index_path, html)
        .with_context(|| format!("failed to write {}", index_path.display()))?;

    Ok(index_path)
}

fn scaffold_html(title: &str) -> String {
    let escaped_title = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        r#"<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escaped_title}</title>
<style>
pre {{ white-space: pre-wrap; word-wrap: break-word; }}
body {{ margin: 2rem; font-family: system-ui, sans-serif; line-height: 1.6; }}
</style>
<!-- Preserve the head above; replace the body below. -->
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_contains_title_and_base_css() {
        let html = scaffold_html("Test & <Title>");
        assert!(html.contains("Test &amp; &lt;Title&gt;"));
        assert!(html.contains("pre { white-space: pre-wrap;"));
        assert!(html.contains("viewport"));
    }

    #[test]
    fn remove_dir_deletes_directory() {
        write_explanation_scaffold("expl-99", "To Delete").unwrap();
        let expl_dir = paths::explanation_dir("expl-99").unwrap();
        assert!(expl_dir.exists());

        remove_explanation_dir("expl-99").unwrap();
        assert!(!expl_dir.exists());

        // idempotent: removing again succeeds
        remove_explanation_dir("expl-99").unwrap();
    }

    #[test]
    fn write_scaffold_creates_file() {
        let path = write_explanation_scaffold("expl-42", "My Explanation").unwrap();

        assert!(path.exists());
        assert!(path.ends_with("expl-42/index.html"));
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("My Explanation"));
    }
}
