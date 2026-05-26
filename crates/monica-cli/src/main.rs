use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "monica", version, about = "Monica Issue Runner")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
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
    let cli = Cli::parse();
    match cli.command {
        Commands::Start { .. }
        | Commands::Status
        | Commands::Review { .. }
        | Commands::Pr { .. } => {
            eprintln!("monica: not yet implemented (see issue #11)");
            std::process::exit(1);
        }
    }
}
