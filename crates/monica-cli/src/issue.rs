use std::process::Command;

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_core::{parse_issue_ref, track_github_issue, Db, GithubIssue};
use serde::Deserialize;

#[derive(Subcommand)]
pub enum IssueCommand {
    /// Track an existing GitHub issue (owner/repo#123) as a Monica work item
    Track {
        /// owner/repo#123
        target: String,
    },
}

pub fn run(cmd: IssueCommand) -> Result<()> {
    let mut db = Db::open()?;
    match cmd {
        IssueCommand::Track { target } => track_command(&mut db, &target),
    }
}

/// `body` arrives as JSON `null` or an absent key for an empty issue, hence `Option` + default.
#[derive(Debug, Deserialize)]
struct GhIssue {
    number: i64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    url: String,
}

fn track_command(db: &mut Db, target: &str) -> Result<()> {
    let (repo, number) = parse_issue_ref(target)?;
    let issue = fetch_issue(&repo, number)?;
    let item = track_github_issue(db, &repo, &issue.to_core())?;
    println!("Created {} from {}#{}", item.id, repo, issue.number);
    println!("Status: {}", item.status.as_str());
    println!("Title: {}", item.title);
    Ok(())
}

fn fetch_issue(repo: &str, number: i64) -> Result<GhIssue> {
    let output = Command::new("gh")
        .args([
            "issue",
            "view",
            &number.to_string(),
            "--repo",
            repo,
            "--json",
            "number,title,body,url",
        ])
        .output()
        .context("failed to run gh; install the GitHub CLI (https://cli.github.com)")?;
    build_issue(
        number,
        output.status.success(),
        &output.stdout,
        &output.stderr,
    )
}

fn build_issue(requested: i64, success: bool, stdout: &[u8], stderr: &[u8]) -> Result<GhIssue> {
    if !success {
        let detail = String::from_utf8_lossy(stderr);
        let detail = detail.trim();
        let detail = if detail.is_empty() {
            "no error output"
        } else {
            detail
        };
        return Err(anyhow!(
            "gh issue view failed: {detail}; is `gh` authenticated? try `gh auth login`"
        ));
    }
    let issue: GhIssue =
        serde_json::from_slice(stdout).context("could not parse gh issue view JSON output")?;
    if issue.number != requested {
        return Err(anyhow!(
            "gh returned issue #{} but #{requested} was requested",
            issue.number
        ));
    }
    Ok(issue)
}

impl GhIssue {
    fn to_core(&self) -> GithubIssue {
        GithubIssue {
            number: self.number,
            title: self.title.clone(),
            body: self.body.clone(),
            url: self.url.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_issue_parses_valid_json() {
        let json = br#"{"number":9,"title":"hello","body":"world","url":"https://example.com/9"}"#;
        let issue = build_issue(9, true, json, b"").unwrap();
        assert_eq!(issue.number, 9);
        assert_eq!(issue.title, "hello");
        assert_eq!(issue.body.as_deref(), Some("world"));
        assert_eq!(issue.url, "https://example.com/9");
    }

    #[test]
    fn build_issue_tolerates_missing_and_null_body() {
        let missing = br#"{"number":1,"title":"t","url":"u"}"#;
        assert_eq!(build_issue(1, true, missing, b"").unwrap().body, None);
        let null = br#"{"number":1,"title":"t","body":null,"url":"u"}"#;
        assert_eq!(build_issue(1, true, null, b"").unwrap().body, None);
    }

    #[test]
    fn build_issue_surfaces_stderr_on_failure() {
        let err = build_issue(999, false, b"", b"gh: could not find issue #999");
        let msg = format!("{:#}", err.unwrap_err());
        assert!(msg.contains("gh: could not find issue #999"), "{msg}");
    }

    #[test]
    fn build_issue_rejects_bad_json() {
        assert!(build_issue(1, true, b"not json", b"").is_err());
    }

    #[test]
    fn build_issue_rejects_number_mismatch() {
        let json = br#"{"number":9,"title":"t","body":"b","url":"u"}"#;
        assert!(build_issue(5, true, json, b"").is_err());
    }
}
