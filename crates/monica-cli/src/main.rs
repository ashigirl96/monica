use clap::{Parser, Subcommand};
use monica_core::start::{self, StartOutcome};

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
        Commands::Start { target } => {
            if let Err(e) = start::start(&target).map(print_outcome) {
                eprintln!("monica: {e}");
                std::process::exit(1);
            }
        }
        Commands::Status | Commands::Review { .. } | Commands::Pr { .. } => {
            eprintln!("monica: not yet implemented (see issue #11)");
            std::process::exit(1);
        }
    }
}

fn print_outcome(outcome: StartOutcome) {
    let m = &outcome.manifest;
    println!("Started session {}", m.id);
    println!("  repo:     {}", m.repo);
    println!("  issue:    #{} {}", m.issue_number, m.issue_url);
    println!("  branch:   {}", m.branch);
    println!("  worktree: {}", m.worktree_path);
    println!("  manifest: {}", outcome.manifest_path.display());
    println!("  prompt:   {}", outcome.prompt_path.display());
    println!();
    println!("Next: cd {} && claude", m.worktree_path);
    println!();
    println!("--- prompt ---");
    print!("{}", outcome.prompt);
}
