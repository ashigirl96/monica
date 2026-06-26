use anyhow::{Context, Result};
use clap::Subcommand;
use monica_application::GithubAuthStatus;

use crate::event_sink::{self, CliFacade};

#[derive(Subcommand)]
pub enum AuthCommand {
    /// Manage Monica's GitHub authorization
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
    let mut monica = event_sink::open()?;
    match cmd {
        GithubAuthCommand::Login => login(&mut monica).await,
        GithubAuthCommand::Status => {
            print_status(&monica.synchronization().auth_status());
            Ok(())
        }
        GithubAuthCommand::Logout => {
            monica.synchronization().logout().await?;
            println!("GitHub authorization removed.");
            Ok(())
        }
    }
}

async fn login(monica: &mut CliFacade) -> Result<()> {
    let flow = monica.synchronization().begin_device_flow().await?;
    println!("Open this URL in your browser:");
    println!("{}", flow.verification_uri);
    println!();
    println!("Enter this code:");
    println!("{}", flow.user_code);
    println!();
    println!("Waiting for GitHub authorization...");

    let status = monica
        .synchronization()
        .wait_for_device_flow(&flow)
        .await
        .context("GitHub authorization did not complete")?;
    println!();
    println!("GitHub authorization saved.");
    print_status(&status);
    println!("For organization repositories, an org owner may need to approve Monica's OAuth app in the organization's third-party access settings.");
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
