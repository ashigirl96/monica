use std::fs;
use std::path::Path;

use anyhow::{anyhow, Result};
use clap::Subcommand;

use monica_core::{
    mermaid_blocks, outline, pages_from_docs, parse_front_matter, structural_lint, LintFinding,
    NotebookDoc,
};
use monica_infra::filesystem::paths;

#[derive(Subcommand)]
pub enum NotebooksCommand {
    /// Create a notebook directory from a kebab-case slug
    New {
        /// kebab-case slug (e.g. step-by-step-guide)
        slug: String,
    },
    /// List notebooks and their page counts
    List,
    /// Print a notebook's page hierarchy as a numbered outline (debug)
    Show {
        /// notebook slug
        slug: String,
    },
    /// Lint a notebook's pages (structure + mermaid are fatal, markdown style is a warning)
    Lint {
        /// notebook slug
        slug: String,
    },
}

pub fn run(cmd: NotebooksCommand) -> Result<()> {
    match cmd {
        NotebooksCommand::New { slug } => new(&slug),
        NotebooksCommand::List => list(),
        NotebooksCommand::Show { slug } => show(&slug),
        NotebooksCommand::Lint { slug } => lint(&slug),
    }
}

fn new(slug: &str) -> Result<()> {
    if !monica_core::is_valid_slug(slug) {
        return Err(anyhow!(
            "invalid slug `{slug}`: use kebab-case (lowercase a-z, 0-9, single hyphens)"
        ));
    }
    let dir = paths::notebook_dir(slug)?;
    fs::create_dir_all(&dir)?;
    println!("{}", dir.display());
    Ok(())
}

fn list() -> Result<()> {
    let root = paths::notebooks_dir()?;
    let mut notebooks: Vec<(String, usize)> = Vec::new();
    if root.is_dir() {
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let slug = entry.file_name().to_string_lossy().into_owned();
                notebooks.push((slug, count_md(&entry.path())?));
            }
        }
    }
    if notebooks.is_empty() {
        println!("No notebooks yet. Create one with `monica notebooks new <slug>`.");
        return Ok(());
    }
    notebooks.sort();
    let mut rows = vec![vec!["SLUG".to_string(), "PAGES".to_string()]];
    for (slug, pages) in notebooks {
        rows.push(vec![slug, pages.to_string()]);
    }
    print!("{}", crate::table::render_table(&rows));
    Ok(())
}

fn show(slug: &str) -> Result<()> {
    let (docs, _) = read_docs(slug)?;
    let entries = outline(&pages_from_docs(&docs));
    if entries.is_empty() {
        println!("(no pages)");
        return Ok(());
    }
    for entry in entries {
        let indent = "  ".repeat(entry.number.matches('.').count());
        println!("{indent}{} {}", entry.number, entry.title);
    }
    Ok(())
}

fn lint(slug: &str) -> Result<()> {
    let (docs, mut fatal) = read_docs(slug)?;
    fatal.extend(structural_lint(&docs));
    for doc in &docs {
        fatal.extend(mermaid_findings(doc));
    }

    for f in &fatal {
        println!("{}: {}", f.file, f.message);
    }
    for w in style_findings(&docs) {
        println!("warning: {}: {}", w.file, w.message);
    }

    if fatal.is_empty() {
        Ok(())
    } else {
        Err(anyhow!("lint failed: {} issue(s)", fatal.len()))
    }
}

/// Files whose front matter fails to parse become findings rather than docs, so one malformed
/// page doesn't abort the whole lint.
fn read_docs(slug: &str) -> Result<(Vec<NotebookDoc>, Vec<LintFinding>)> {
    let dir = paths::notebook_dir(slug)?;
    if !dir.is_dir() {
        return Err(anyhow!("notebook `{slug}` not found at {}", dir.display()));
    }
    let mut md_files: Vec<_> = fs::read_dir(&dir)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .collect();
    md_files.sort();

    let mut docs = Vec::new();
    let mut findings = Vec::new();
    for path in md_files {
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

fn count_md(dir: &Path) -> Result<usize> {
    let count = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .count();
    Ok(count)
}

fn mermaid_findings(doc: &NotebookDoc) -> Vec<LintFinding> {
    mermaid_blocks(&doc.body)
        .iter()
        // Trim: a trailing newline flips mmdflux into lenient mode and masks real syntax errors.
        .filter_map(|block| {
            mermaid_error(&mmdflux::validate_diagram(block.trim())).map(|message| LintFinding {
                file: doc.file.clone(),
                message,
            })
        })
        .collect()
}

/// `None` when valid or when the report can't be parsed — mermaid lint must never produce a
/// false fatal.
fn mermaid_error(report: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(report).ok()?;
    if value.get("valid").and_then(serde_json::Value::as_bool).unwrap_or(true) {
        return None;
    }
    let diagnostics = value
        .get("diagnostics")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| item.to_string())
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default();
    Some(if diagnostics.is_empty() {
        "invalid mermaid diagram".to_string()
    } else {
        format!("invalid mermaid diagram: {diagnostics}")
    })
}

/// rumdl's internal errors are swallowed: markdown style is non-fatal and must never change the
/// exit code.
fn style_findings(docs: &[NotebookDoc]) -> Vec<LintFinding> {
    use rumdl_lib::config::{Config, MarkdownFlavor};

    let config = Config::default();
    let rules = rumdl_lib::rules::all_rules(&config);
    let mut findings = Vec::new();
    for doc in docs {
        let Ok(warnings) = rumdl_lib::lint(&doc.body, &rules, false, MarkdownFlavor::Standard, None, None)
        else {
            continue;
        };
        for warning in warnings {
            let rule = warning.rule_name.as_deref().unwrap_or("-");
            findings.push(LintFinding {
                file: doc.file.clone(),
                message: format!("L{} [{}] {}", warning.line, rule, warning.message),
            });
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mermaid_findings_for(mermaid: &str) -> Vec<LintFinding> {
        let doc = NotebookDoc {
            file: "t.md".to_string(),
            stem: "t".to_string(),
            front: Vec::new(),
            body: format!("```mermaid\n{mermaid}\n```\n"),
        };
        mermaid_findings(&doc)
    }

    #[test]
    fn mermaid_valid_diagram_has_no_findings() {
        assert!(mermaid_findings_for("graph TD\n  A --> B").is_empty());
    }

    #[test]
    fn mermaid_invalid_diagram_is_flagged() {
        assert!(!mermaid_findings_for("graph TD\n  A --> ").is_empty());
        assert!(!mermaid_findings_for("not a diagram").is_empty());
    }
}
