mod auth;
mod hook;
mod issue;
mod project;

use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::Shell;

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
    /// Track GitHub issues as Monica tasks
    #[command(subcommand)]
    Issue(issue::IssueCommand),
    /// Receive agent lifecycle hooks (e.g. `monica hook claude`)
    #[command(subcommand)]
    Hook(hook::HookCommand),
    /// Manage Monica authorization
    #[command(subcommand)]
    Auth(auth::AuthCommand),
    /// Start a worktree + session for an issue (owner/repo#123)
    Start { target: String },
    /// Show the status of all sessions
    Status,
    /// Review the diff and PR status for an issue
    Review { target: String },
    /// Push the branch and open a PR for an issue
    Pr { target: String },
    /// Print a shell completion script (e.g. `monica completions zsh`)
    Completions { shell: Shell },
}

fn main() {
    if let Err(err) = run(Cli::parse()) {
        eprintln!("monica: {err:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .enable_io()
        .build()?;
    runtime.block_on(async move {
        match cli.command {
            Commands::Project(cmd) => project::run(cmd).await,
            Commands::Issue(cmd) => issue::run(cmd).await,
            Commands::Auth(cmd) => auth::run(cmd).await,
            Commands::Hook(cmd) => hook::run(cmd),
            Commands::Completions { shell } => {
                let mut cmd = Cli::command();
                let name = cmd.get_name().to_string();
                clap_complete::generate(shell, &mut cmd, name, &mut std::io::stdout());
                Ok(())
            }
            Commands::Start { .. }
            | Commands::Status
            | Commands::Review { .. }
            | Commands::Pr { .. } => {
                eprintln!("monica: not yet implemented (see issue #11)");
                std::process::exit(1);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_delete_rejects_yes_flag() {
        assert!(Cli::try_parse_from(["monica", "issue", "delete", "MON-1", "-y"]).is_err());
        assert!(Cli::try_parse_from(["monica", "issue", "delete", "MON-1", "--yes"]).is_err());
    }
}
