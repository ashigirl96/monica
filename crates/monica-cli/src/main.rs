mod event_sink;
mod explain;
mod hook;
mod note;
mod notify;
mod project;
mod table;
mod task;

use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::Shell;

#[derive(Parser)]
#[command(name = "monica", version, about = "Monica Task Runner")]
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
    /// Manage Monica tasks (track GitHub issues, show status, close)
    #[command(subcommand)]
    Task(task::TaskCommand),
    /// Read notes as markdown / search note bodies
    #[command(subcommand)]
    Note(note::NoteCommand),
    /// Receive agent lifecycle hooks (e.g. `monica hook claude`)
    #[command(subcommand)]
    Hook(hook::HookCommand),
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
            Commands::Task(cmd) => task::run(cmd).await,
            Commands::Note(cmd) => note::run(cmd),
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
    fn task_close_replaces_delete_and_has_no_yes_bypass() {
        assert!(Cli::try_parse_from(["monica", "task", "close", "MON-1"]).is_ok());
        // close confirms interactively; there is no --yes bypass flag.
        assert!(Cli::try_parse_from(["monica", "task", "close", "MON-1", "-y"]).is_err());
        assert!(Cli::try_parse_from(["monica", "task", "close", "MON-1", "--yes"]).is_err());
        // the old `delete` subcommand is gone.
        assert!(Cli::try_parse_from(["monica", "task", "delete", "MON-1"]).is_err());
        // the old `issue` subcommand is gone (renamed to `task`, no alias).
        assert!(Cli::try_parse_from(["monica", "issue", "close", "MON-1"]).is_err());
    }

    #[test]
    fn note_show_and_search_parse() {
        assert!(Cli::try_parse_from(["monica", "note", "show", "note-1"]).is_ok());
        assert!(
            Cli::try_parse_from(["monica", "note", "show", "note-1", "--format", "md", "--expand"])
                .is_ok()
        );
        assert!(Cli::try_parse_from(["monica", "note", "show", "note-1", "--format", "json"])
            .is_ok());
        assert!(Cli::try_parse_from(["monica", "note", "search", "hello"]).is_ok());
        // unknown format value is rejected by clap's ValueEnum.
        assert!(Cli::try_parse_from(["monica", "note", "show", "note-1", "--format", "html"])
            .is_err());
        // search requires a query argument.
        assert!(Cli::try_parse_from(["monica", "note", "search"]).is_err());
    }
}
