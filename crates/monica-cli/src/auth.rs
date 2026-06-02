use anyhow::{Context, Result};
use clap::Subcommand;
use monica_core::GithubAuthStatus;
use monica_infra::Runtime;

#[derive(Subcommand)]
pub enum AuthCommand {
    /// Manage Monica's GitHub App authorization
    #[command(subcommand)]
    Github(GithubAuthCommand),
}

#[derive(Subcommand)]
pub enum GithubAuthCommand {
    /// Authorize Monica with GitHub using device flow
    Login,
    /// Show Monica's GitHub authorization status
    Status,
    /// Remove Monica's stored GitHub authorization
    Logout,
}

pub async fn run(cmd: AuthCommand) -> Result<()> {
    match cmd {
        AuthCommand::Github(cmd) => run_github(cmd).await,
    }
}

async fn run_github(cmd: GithubAuthCommand) -> Result<()> {
    let runtime = Runtime::open_default()?;
    match cmd {
        GithubAuthCommand::Login => login(&runtime).await,
        GithubAuthCommand::Status => {
            print_status(&monica_core::github_auth_status(&runtime.auth));
            Ok(())
        }
        GithubAuthCommand::Logout => {
            monica_core::logout_github(&runtime.auth).await?;
            println!("GitHub authorization removed.");
            Ok(())
        }
    }
}

async fn login(runtime: &Runtime) -> Result<()> {
    let flow = monica_core::begin_github_device_flow(&runtime.auth).await?;
    println!("Open this URL in your browser:");
    println!("{}", flow.verification_uri);
    println!();
    println!("Enter this code:");
    println!("{}", flow.user_code);
    println!();
    println!("Waiting for GitHub authorization...");

    let status = monica_core::wait_for_github_device_flow(&runtime.auth, &flow)
        .await
        .context("GitHub authorization did not complete")?;
    println!();
    println!("GitHub authorization saved.");
    print_status(&status);
    println!("Install or update repository access here if needed:");
    println!("{}", monica_core::github_app_install_url(&runtime.auth));
    Ok(())
}

fn print_status(status: &GithubAuthStatus) {
    println!(
        "Status: {}",
        if status.authenticated {
            "authenticated"
        } else {
            "not authenticated"
        }
    );
    println!("Source: {}", status.source);
    println!("Login: {}", status.login.as_deref().unwrap_or("-"));
    println!(
        "Access expires: {}",
        display_epoch(status.access_expires_at)
    );
    println!(
        "Refresh expires: {}",
        display_epoch(status.refresh_expires_at)
    );
    if status.reauth_required {
        println!("Reauth required: yes");
    }
    if let Some(message) = status.message.as_deref() {
        println!("Message: {message}");
    }
}

fn display_epoch(value: Option<i64>) -> String {
    value.map_or_else(|| "-".to_string(), |value| value.to_string())
}
