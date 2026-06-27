use anyhow::{anyhow, Result};
use clap::Subcommand;

use monica_domain::{LintFinding, NotebookDoc};

use crate::event_sink::{self, CliFacade};

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
    let mut monica = event_sink::open()?;
    match cmd {
        NotebooksCommand::New { slug } => new(&mut monica, &slug),
        NotebooksCommand::List => list(&mut monica),
        NotebooksCommand::Show { slug } => show(&mut monica, &slug),
        NotebooksCommand::Lint { slug } => lint(&mut monica, &slug),
    }
}

fn new(monica: &mut CliFacade, slug: &str) -> Result<()> {
    let dir = monica.notebooks().create_notebook(slug)?;
    println!("{}", dir.display());
    Ok(())
}

fn list(monica: &mut CliFacade) -> Result<()> {
    let notebooks = monica.notebooks().list_notebooks()?;
    if notebooks.is_empty() {
        println!("No notebooks yet. Create one with `monica notebooks new <slug>`.");
        return Ok(());
    }
    let mut rows = vec![vec!["SLUG".to_string(), "PAGES".to_string()]];
    for (slug, pages) in notebooks {
        rows.push(vec![slug, pages.to_string()]);
    }
    print!("{}", crate::table::render_table(&rows));
    Ok(())
}

fn show(monica: &mut CliFacade, slug: &str) -> Result<()> {
    let pages = monica.notebooks().page_outline(slug)?;
    if pages.is_empty() {
        println!("(no pages)");
        return Ok(());
    }
    for page in pages {
        let indent = "  ".repeat(page.number.matches('.').count());
        println!("{indent}{} {}", page.number, page.title);
    }
    Ok(())
}

fn lint(monica: &mut CliFacade, slug: &str) -> Result<()> {
    let report = monica.notebooks().notebook_lint(slug)?;
    let mut fatal = report.findings;
    for (file, blocks) in &report.mermaid_blocks_by_file {
        fatal.extend(mermaid_findings(file, blocks));
    }

    for f in &fatal {
        println!("{}: {}", f.file, f.message);
    }
    for w in style_findings(&report.docs) {
        println!("warning: {}: {}", w.file, w.message);
    }

    if fatal.is_empty() {
        Ok(())
    } else {
        Err(anyhow!("lint failed: {} issue(s)", fatal.len()))
    }
}

fn mermaid_findings(file: &str, blocks: &[String]) -> Vec<LintFinding> {
    blocks
        .iter()
        .filter_map(|block| {
            mermaid_error(&mmdflux::validate_diagram(block)).map(|message| LintFinding {
                file: file.to_string(),
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
        mermaid_findings("t.md", &[mermaid.to_string()])
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
