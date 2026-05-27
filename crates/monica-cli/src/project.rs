use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_core::{register_project, Db};

#[derive(Subcommand)]
pub enum ProjectCommand {
    /// Register a repo (from owner/repo or the current git remote) and scaffold .monica/
    Init {
        /// owner/repo; detected from `git remote get-url origin` when omitted
        repo: Option<String>,
    },
    /// Set a single field on a registered project
    Set {
        /// owner/repo
        repo: String,
        key: String,
        value: String,
    },
    /// List registered projects
    List,
    /// Show one project's detail
    Show {
        /// owner/repo
        repo: String,
        /// Emit machine-readable JSON
        #[arg(long)]
        json: bool,
    },
}

pub fn run(cmd: ProjectCommand) -> Result<()> {
    let db = Db::open()?;
    match cmd {
        ProjectCommand::Init { repo } => init(&db, repo),
        ProjectCommand::Set { repo, key, value } => set(&db, &repo, &key, &value),
        ProjectCommand::List => list(&db),
        ProjectCommand::Show { repo, json } => show(&db, &repo, json),
    }
}

fn init(db: &Db, repo_arg: Option<String>) -> Result<()> {
    let cwd = std::env::current_dir().context("failed to read current directory")?;
    let repo = match repo_arg {
        Some(repo) => repo,
        None => detect_repo()?,
    };
    let saved = register_project(db, &repo, &cwd)?;

    println!(
        "Registered project {} (path: {})",
        saved.id,
        saved.path.as_deref().unwrap_or("-")
    );
    for (file, created) in scaffold_monica(&cwd)? {
        let status = if created {
            "created"
        } else {
            "skipped (exists)"
        };
        println!("  {file:<19}{status}");
    }
    Ok(())
}

fn set(db: &Db, repo: &str, key: &str, value: &str) -> Result<()> {
    db.set_project_field(repo, key, value)?;
    println!("Set {repo}.{key} = {value}");
    Ok(())
}

fn list(db: &Db) -> Result<()> {
    let projects = db.list_projects()?;
    if projects.is_empty() {
        println!("No projects registered. Run `monica project init` inside a repo.");
        return Ok(());
    }

    let mut table = vec![vec![
        "ID".to_string(),
        "PATH".to_string(),
        "BRANCH".to_string(),
        "AGENT".to_string(),
        "TIMEOUT".to_string(),
    ]];
    for p in &projects {
        table.push(vec![
            p.id.clone(),
            p.path.clone().unwrap_or_else(|| "-".to_string()),
            p.default_branch.clone(),
            p.agent_default.as_str().to_string(),
            p.setup_timeout_sec.to_string(),
        ]);
    }
    print_table(&table);
    Ok(())
}

fn show(db: &Db, repo: &str, json: bool) -> Result<()> {
    let project = db
        .get_project(repo)?
        .ok_or_else(|| anyhow!("project not found: {repo}"))?;

    if json {
        println!("{}", serde_json::to_string_pretty(&project)?);
        return Ok(());
    }

    let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "-".to_string());
    let fields = [
        ("id", project.id.clone()),
        ("name", project.name.clone()),
        ("provider", project.provider.as_str().to_string()),
        ("repo", project.repo.clone()),
        ("path", opt(&project.path)),
        ("default_branch", project.default_branch.clone()),
        ("worktree_root", opt(&project.worktree_root)),
        ("branch_template", project.branch_template.clone()),
        ("setup_timeout_sec", project.setup_timeout_sec.to_string()),
        ("agent_default", project.agent_default.as_str().to_string()),
        (
            "agent_permission_mode",
            project.agent_permission_mode.as_str().to_string(),
        ),
        ("hooks_claude", project.hooks_claude.to_string()),
        ("created_at", project.created_at.clone()),
        ("updated_at", project.updated_at.clone()),
    ];
    let width = fields.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (key, value) in fields {
        println!("{key:<width$}  {value}");
    }
    Ok(())
}

/// Read `git remote get-url origin` in the current directory and extract `owner/repo`.
fn detect_repo() -> Result<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .output()
        .context("failed to run git; install git or pass owner/repo explicitly")?;
    if !output.status.success() {
        return Err(anyhow!(
            "could not read `git remote get-url origin`; run inside a repo or pass owner/repo explicitly"
        ));
    }
    let url = String::from_utf8(output.stdout).context("git remote url was not valid UTF-8")?;
    monica_core::parse_owner_repo(&url)
}

fn scaffold_monica(dir: &Path) -> Result<Vec<(String, bool)>> {
    let monica_dir = dir.join(".monica");
    fs::create_dir_all(&monica_dir)
        .with_context(|| format!("failed to create {}", monica_dir.display()))?;
    Ok(vec![
        write_if_absent(&monica_dir, "setup.sh", SETUP_SH_TEMPLATE, true)?,
        write_if_absent(&monica_dir, "prompt.md", PROMPT_MD_TEMPLATE, false)?,
    ])
}

/// Write `name` under `dir` only if it does not already exist. Returns `(.monica/<name>, created?)`
/// so a pre-existing file (a user's committed convention) is never clobbered.
fn write_if_absent(
    dir: &Path,
    name: &str,
    contents: &str,
    executable: bool,
) -> Result<(String, bool)> {
    let path = dir.join(name);
    let rel = format!(".monica/{name}");
    if path.exists() {
        return Ok((rel, false));
    }
    fs::write(&path, contents).with_context(|| format!("failed to write {}", path.display()))?;
    if executable {
        set_executable(&path)?;
    }
    Ok((rel, true))
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).with_context(|| format!("failed to chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn print_table(rows: &[Vec<String>]) {
    let cols = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    if cols == 0 {
        return;
    }
    let mut widths = vec![0usize; cols];
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    for row in rows {
        let line = row
            .iter()
            .enumerate()
            .map(|(i, cell)| format!("{cell:<width$}", width = widths[i]))
            .collect::<Vec<_>>()
            .join("  ");
        println!("{}", line.trim_end());
    }
}

const SETUP_SH_TEMPLATE: &str = r#"#!/usr/bin/env bash
set -euo pipefail

# Monica runs this in the worktree before launching the agent. Keep it idempotent.
# Available env: MONICA_ID, MONICA_RUN_ID, MONICA_PROJECT_ID (branch / worktree path も渡される)
# 例:
#   corepack enable
#   pnpm install --frozen-lockfile
"#;

const PROMPT_MD_TEMPLATE: &str = r#"<!-- Monica passes this file's contents as the initial prompt to the agent. -->
/tackle
"#;
