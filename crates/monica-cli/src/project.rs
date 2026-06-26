use anyhow::{Context, Result};
use clap::Subcommand;
use monica_application::GitGateway;
use monica_infra::Runtime;

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
    let mut runtime = Runtime::open_default()?;
    match cmd {
        ProjectCommand::Init { repo } => init(&mut runtime, repo).await,
        ProjectCommand::Set { repo, key, value } => set(&runtime, &repo, &key, &value),
        ProjectCommand::List => list(&runtime),
        ProjectCommand::Show { repo, json } => show(&runtime, &repo, json),
    }
}

async fn init(runtime: &mut Runtime, repo_arg: Option<String>) -> Result<()> {
    let cwd = std::env::current_dir().context("failed to read current directory")?;
    let repo = match repo_arg {
        Some(repo) => repo,
        None => runtime.git.detect_repo()?,
    };
    let default_branch = detect_default_branch(runtime, &repo).await;
    let saved = monica_application::register_project_with_default_branch(
        &runtime.repositories,
        &repo,
        &cwd,
        default_branch.as_deref(),
    )?;

    println!(
        "Registered project {} (path: {}, default_branch: {})",
        saved.id,
        saved.path.as_deref().unwrap_or("-"),
        saved.default_branch
    );
    for (file, created) in runtime.scaffold_monica(&cwd)? {
        let status = if created {
            "created"
        } else {
            "skipped (exists)"
        };
        println!("  {file:<19}{status}");
    }
    Ok(())
}

fn set(runtime: &Runtime, repo: &str, key: &str, value: &str) -> Result<()> {
    monica_application::set_project_field(&runtime.repositories, repo, key, value)?;
    println!("Set {repo}.{key} = {value}");
    Ok(())
}

fn list(runtime: &Runtime) -> Result<()> {
    let projects = monica_application::list_projects(&runtime.repositories)?;
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
            crate::table::or_dash(p.path.as_deref()),
            p.default_branch.clone(),
            p.agent_default.as_str().to_string(),
            p.setup_timeout_sec.to_string(),
        ]);
    }
    print!("{}", crate::table::render_table(&table));
    Ok(())
}

fn show(runtime: &Runtime, repo: &str, json: bool) -> Result<()> {
    let project = monica_application::get_project(&runtime.repositories, repo)?;

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
            crate::table::or_dash(project.worktree_root.as_deref()),
        ),
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

async fn detect_default_branch(runtime: &Runtime, repo: &str) -> Option<String> {
    if let Some(branch) = runtime.git.detect_default_branch(repo) {
        return Some(branch);
    }
    runtime
        .github
        .fetch_default_branch(repo)
        .await
        .ok()
        .flatten()
}
