mod auth;
mod event_sink;
mod explain;
mod hook;
mod issue;
mod notify;
mod project;
mod table;

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
    /// Create and manage explanation documents
    #[command(subcommand)]
    Explain(explain::ExplainCommand),
    /// Track GitHub issues as Monica tasks
    #[command(subcommand)]
    Issue(issue::IssueCommand),
    /// Receive agent lifecycle hooks (e.g. `monica hook claude`)
    #[command(subcommand)]
    Hook(hook::HookCommand),
    /// Manage Monica authorization
    #[command(subcommand)]
    Auth(auth::AuthCommand),
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
            Commands::Explain(cmd) => explain::run(cmd),
            Commands::Issue(cmd) => issue::run(cmd).await,
            Commands::Auth(cmd) => auth::run(cmd).await,
            Commands::Hook(cmd) => hook::run(cmd),
            Commands::Completions { shell } => {
                let mut cmd = Cli::command();
                let name = cmd.get_name().to_string();
                clap_complete::generate(shell, &mut cmd, name, &mut std::io::stdout());
                Ok(())
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_close_replaces_delete_and_has_no_yes_bypass() {
        assert!(Cli::try_parse_from(["monica", "issue", "close", "MON-1"]).is_ok());
        // close confirms interactively; there is no --yes bypass flag.
        assert!(Cli::try_parse_from(["monica", "issue", "close", "MON-1", "-y"]).is_err());
        assert!(Cli::try_parse_from(["monica", "issue", "close", "MON-1", "--yes"]).is_err());
        // the old `delete` subcommand is gone.
        assert!(Cli::try_parse_from(["monica", "issue", "delete", "MON-1"]).is_err());
    }
}
