mod auth;
mod event_sink;
mod hook;
mod issue;
mod notebooks;
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
    /// Track GitHub issues as Monica tasks
    #[command(subcommand)]
    Issue(issue::IssueCommand),
    /// Receive agent lifecycle hooks (e.g. `monica hook claude`)
    #[command(subcommand)]
    Hook(hook::HookCommand),
    /// Manage notebooks (rendered Markdown page collections under `$MONICA_HOME/notebooks`)
    #[command(subcommand)]
    Notebooks(notebooks::NotebooksCommand),
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
            Commands::Issue(cmd) => issue::run(cmd).await,
            Commands::Auth(cmd) => auth::run(cmd).await,
            Commands::Hook(cmd) => hook::run(cmd),
            Commands::Notebooks(cmd) => notebooks::run(cmd),
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

    #[test]
    fn notebooks_subcommands_parse() {
        for args in [
            ["monica", "notebooks", "new", "step-by-step"].as_slice(),
            ["monica", "notebooks", "list"].as_slice(),
            ["monica", "notebooks", "show", "step-by-step"].as_slice(),
            ["monica", "notebooks", "lint", "step-by-step"].as_slice(),
        ] {
            assert!(Cli::try_parse_from(args).is_ok(), "{args:?}");
        }
        // `new` and `lint` require their positional argument.
        assert!(Cli::try_parse_from(["monica", "notebooks", "new"]).is_err());
        assert!(Cli::try_parse_from(["monica", "notebooks", "lint"]).is_err());
    }
}
