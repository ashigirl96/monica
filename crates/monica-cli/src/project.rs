use anyhow::{Context, Result};
use clap::Subcommand;

use crate::event_sink::{self, CliFacade};

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

pub async fn run(cmd: ProjectCommand) -> Result<()> {
    let mut monica = event_sink::open()?;
    match cmd {
        ProjectCommand::Init { repo } => init(&mut monica, repo).await,
        ProjectCommand::Set { repo, key, value } => set(&mut monica, &repo, &key, &value),
        ProjectCommand::List => list(&mut monica),
        ProjectCommand::Show { repo, json } => show(&mut monica, &repo, json),
    }
}

async fn init(monica: &mut CliFacade, repo_arg: Option<String>) -> Result<()> {
    let cwd = std::env::current_dir().context("failed to read current directory")?;
    let report = monica.projects().init_project(repo_arg, &cwd).await?;

    let saved = report.project;
    println!(
        "Registered project {} (path: {}, default_branch: {})",
        saved.id,
        saved.path.as_deref().unwrap_or("-"),
        saved.default_branch
    );
    for (file, created) in report.scaffold {
        let status = if created {
            "created"
        } else {
            "skipped (exists)"
        };
        println!("  {file:<19}{status}");
    }
    Ok(())
}

fn set(monica: &mut CliFacade, repo: &str, key: &str, value: &str) -> Result<()> {
    monica.projects().set_project_field(repo, key, value)?;
    println!("Set {repo}.{key} = {value}");
    Ok(())
}

fn list(monica: &mut CliFacade) -> Result<()> {
    let projects = monica.projects().list_projects()?;
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
        let profile = monica.projects().get_execution_profile(&p.id)?;
        table.push(vec![
            p.id.clone(),
            crate::table::or_dash(p.path.as_deref()),
            p.default_branch.clone(),
            profile.agent_default.as_str().to_string(),
            profile.setup_timeout_sec.to_string(),
        ]);
    }
    print!("{}", crate::table::render_table(&table));
    Ok(())
}

fn show(monica: &mut CliFacade, repo: &str, json: bool) -> Result<()> {
    let project = monica.projects().get_project(repo)?;
    let profile = monica.projects().get_execution_profile(repo)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&project)?);
        return Ok(());
    }

    let fields = [
        ("id", project.id.clone()),
        ("name", project.name.clone()),
        ("provider", project.provider.as_str().to_string()),
        ("repo", project.repo.clone()),
        ("path", crate::table::or_dash(project.path.as_deref())),
        ("default_branch", project.default_branch.clone()),
        (
            "worktree_root",
            crate::table::or_dash(profile.worktree_root.as_deref()),
        ),
        ("setup_timeout_sec", profile.setup_timeout_sec.to_string()),
        ("agent_default", profile.agent_default.as_str().to_string()),
        (
            "agent_permission_mode",
            profile.agent_permission_mode.as_str().to_string(),
        ),
        ("hooks_claude", profile.hooks_claude.to_string()),
        ("created_at", project.created_at.clone()),
        ("updated_at", project.updated_at.clone()),
    ];
    let width = fields.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (key, value) in fields {
        println!("{key:<width$}  {value}");
    }
    Ok(())
}
