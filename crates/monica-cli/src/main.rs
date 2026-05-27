mod issue;
mod project;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "monica", version, about = "Monica Issue Runner")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage the project registry (execution-environment definitions)
    #[command(subcommand)]
    Project(project::ProjectCommand),
    /// Track GitHub issues as Monica work items
    #[command(subcommand)]
    Issue(issue::IssueCommand),
    /// Start a worktree + session for an issue (owner/repo#123)
    Start { target: String },
    /// Show the status of all sessions
    Status,
    /// Review the diff and PR status for an issue
    Review { target: String },
    /// Push the branch and open a PR for an issue
    Pr { target: String },
}

fn main() {
    if let Err(err) = run(Cli::parse()) {
        eprintln!("monica: {err:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Commands::Project(cmd) => project::run(cmd),
        Commands::Issue(cmd) => issue::run(cmd),
        Commands::Start { .. }
        | Commands::Status
        | Commands::Review { .. }
        | Commands::Pr { .. } => {
            eprintln!("monica: not yet implemented (see issue #11)");
            std::process::exit(1);
        }
    }
}
