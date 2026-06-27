use std::io::{self, Write};

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_application::{parse_issue_input, TaskSummaryRow};
use monica_domain::{parse_owner_repo, DisplayStatus, Task};

use crate::event_sink::{self, CliFacade};

#[derive(Subcommand)]
pub enum IssueCommand {
    /// Track an existing GitHub issue (owner/repo#123 or issue URL) as a Monica task
    Track {
        /// owner/repo#123 or GitHub issue URL
        target: String,
    },
    /// Show tracked tasks and their latest run state
    Status {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
    /// Close a tracked Monica issue (MON-<id>)
    Close {
        /// MON-<id>
        id: String,
    },
}

pub async fn run(cmd: IssueCommand) -> Result<()> {
    let mut monica = event_sink::open()?;
    match cmd {
        IssueCommand::Track { target } => track_command(&mut monica, &target).await,
        IssueCommand::Status { status, project } => status_command(&mut monica, status, project),
        IssueCommand::Close { id } => close_command(&mut monica, &id),
    }
}

async fn track_command(monica: &mut CliFacade, target: &str) -> Result<()> {
    let (repo, number) = parse_issue_input(target)?;
    let report = monica
        .synchronization()
        .track_github_issue(repo.clone(), number)
        .await
        .with_context(|| format!("failed to fetch GitHub issue {repo}#{number}"))?;
    let item = report.task;
    let issue = report.issue;
    println!("Created {} from {}#{}", item.id, repo, issue.number);
    println!("Status: {}", item.status.as_str());
    println!("Title: {}", item.title);
    Ok(())
}

fn status_command(
    monica: &mut CliFacade,
    status: Option<String>,
    project: Option<String>,
) -> Result<()> {
    let status = parse_status_filter(status.as_deref())?;
    let project = normalize_project_filter(project.as_deref())?;
    let rows = match status {
        Some(s) => monica.tasks().list_task_summaries_by_status(s, project.as_deref())?,
        None => monica.tasks().list_active_task_summaries(project.as_deref())?,
    };
    print!("{}", render_status_table(&rows));
    Ok(())
}

fn close_command(monica: &mut CliFacade, id: &str) -> Result<()> {
    let item = monica
        .tasks()
        .list_tasks()?
        .into_iter()
        .find(|task| task.id == id)
        .ok_or_else(|| anyhow!("Issue not found: {id}"))?;
    let project = monica
        .tasks()
        .list_all_task_summaries(None)?
        .into_iter()
        .find(|row| row.id == item.id.as_str())
        .and_then(|row| row.project);

    print_close_summary(&item, project.as_deref());
    if !confirm_close()? {
        println!("Canceled.");
        return Ok(());
    }

    let report = monica.tasks().close_issue(id)?;
    println!("Closed issue {}.", report.item.id);
    if !report.task_runs.is_empty() {
        println!("Preserved task runs: {}.", report.task_runs.join(", "));
    }
    if !report.removed_branches.is_empty() {
        println!("Removed branches: {}.", report.removed_branches.join(", "));
    }
    Ok(())
}

fn print_close_summary(item: &Task, project: Option<&str>) {
    println!("Close issue?");
    println!();
    println!("  ID:      {}", item.id);
    println!("  Title:   {}", item.title);
    println!("  Status:  {}", item.status.as_str());
    println!("  Project: {}", project.unwrap_or("-"));
    println!();
    println!("This cannot be undone.");
}

fn confirm_close() -> Result<bool> {
    print!("Continue? [y/N] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(is_yes(answer.trim()))
}

fn is_yes(answer: &str) -> bool {
    answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
}

fn parse_status_filter(status: Option<&str>) -> Result<Option<DisplayStatus>> {
    match status {
        Some(token) => Ok(Some(DisplayStatus::parse_token(token)?)),
        None => Ok(None),
    }
}

fn normalize_project_filter(project: Option<&str>) -> Result<Option<String>> {
    project.map(parse_owner_repo).transpose().map_err(Into::into)
}

fn render_status_table(rows: &[TaskSummaryRow]) -> String {
    if rows.is_empty() {
        return "No tracked issues found.\n".to_string();
    }

    let mut table = vec![vec![
        "ID".to_string(),
        "PROJECT".to_string(),
        "GH ISSUE".to_string(),
        "STATUS".to_string(),
        "BRANCH".to_string(),
    ]];
    for row in rows {
        let github_issue = row.github_issue_number.map(|n| format!("#{n}"));
        table.push(vec![
            row.id.clone(),
            crate::table::or_dash(row.project.as_deref()),
            crate::table::or_dash(github_issue.as_deref()),
            row.status.as_str().to_string(),
            crate::table::or_dash(row.branch.as_deref()),
        ]);
    }
    crate::table::render_table(&table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_domain::TaskStatus;

    #[test]
    fn parse_status_filter_defaults_to_none_and_validates_enum() {
        assert_eq!(parse_status_filter(None).unwrap(), None);
        assert_eq!(
            parse_status_filter(Some("ready")).unwrap(),
            Some(DisplayStatus::Ready)
        );
        assert_eq!(
            parse_status_filter(Some("closed")).unwrap(),
            Some(DisplayStatus::Closed)
        );
        assert!(parse_status_filter(Some("bogus")).is_err());
    }

    #[test]
    fn normalize_project_filter_uses_owner_repo_parser() {
        assert_eq!(
            normalize_project_filter(Some("AshiGirl96/Monica")).unwrap(),
            Some("ashigirl96/monica".to_string())
        );
        assert!(normalize_project_filter(Some("bad")).is_err());
    }

    #[test]
    fn render_status_table_formats_rows_and_empty_state() {
        let rows = vec![TaskSummaryRow {
            id: "MON-1".to_string(),
            title: "Test issue".to_string(),
            project: Some("ashigirl96/monica".to_string()),
            github_issue_number: Some(17),
            github_pull_requests: Vec::new(),
            task_status: TaskStatus::Ready,
            task_run_status: None,
            task_run_wait_reason: None,
            has_plan: false,
            status: DisplayStatus::Ready,
            prepare_eligible: true,
            run_eligible: true,
            is_active: false,
            has_open_pull_request: false,
            branch: Some("monica/gh-17".to_string()),
            side_runs_running: 0,
            side_runs_waiting_for_user: 0,
            side_runs_failed: 0,
        }];
        let rendered = render_status_table(&rows);
        assert!(rendered.contains("ID"));
        assert!(rendered.contains("ashigirl96/monica"));
        assert!(rendered.contains("#17"));
        assert!(rendered.contains("BRANCH"));
        assert!(!rendered
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .any(|column| column == "PR"));

        assert_eq!(render_status_table(&[]), "No tracked issues found.\n");
    }
}
