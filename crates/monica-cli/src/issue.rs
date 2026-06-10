use std::io::{self, Write};

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_core::{
    parse_issue_ref, parse_owner_repo, DisplayStatus, Task, TaskStatus, TaskSummaryRow,
    TrackGithubIssueInput,
};
use monica_infra::Runtime;

#[derive(Subcommand)]
pub enum IssueCommand {
    /// Track an existing GitHub issue (owner/repo#123) as a Monica task
    Track {
        /// owner/repo#123
        target: String,
    },
    /// Show tracked tasks and their latest run state
    Status {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
    /// Delete a tracked Monica issue (MON-<id>)
    Delete {
        /// MON-<id>
        id: String,
    },
    /// Explicitly set a task's status/phase (e.g. `monica issue mark MON-1 in-progress`)
    Mark {
        /// MON-<id>
        id: String,
        /// Task status token: inbox / ready / in-progress / done
        status: String,
        /// Free-text note, stored as the task's phase
        #[arg(long)]
        note: Option<String>,
    },
}

pub async fn run(cmd: IssueCommand) -> Result<()> {
    let mut runtime = Runtime::open_default()?;
    match cmd {
        IssueCommand::Track { target } => track_command(&mut runtime, &target).await,
        IssueCommand::Status { status, project } => status_command(&runtime, status, project),
        IssueCommand::Delete { id } => delete_command(&mut runtime, &id),
        IssueCommand::Mark { id, status, note } => {
            mark_command(&mut runtime, &id, &status, note.as_deref())
        }
    }
}

async fn track_command(runtime: &mut Runtime, target: &str) -> Result<()> {
    let (repo, number) = parse_issue_ref(target)?;
    let report = monica_core::track_github_issue(
        &mut runtime.repositories,
        &runtime.github,
        TrackGithubIssueInput {
            repo: repo.clone(),
            number,
        },
    )
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
    runtime: &Runtime,
    status: Option<String>,
    project: Option<String>,
) -> Result<()> {
    let status = parse_status_filter(status.as_deref())?;
    let project = normalize_project_filter(project.as_deref())?;
    let rows = monica_core::list_task_summaries(&runtime.repositories, status, project.as_deref())?;
    print!("{}", render_status_table(&rows));
    Ok(())
}

fn delete_command(runtime: &mut Runtime, id: &str) -> Result<()> {
    let item = monica_core::list_tasks(&runtime.repositories)?
        .into_iter()
        .find(|task| task.id == id)
        .ok_or_else(|| anyhow!("Issue not found: {id}"))?;
    let project = monica_core::list_task_summaries(&runtime.repositories, None, None)?
        .into_iter()
        .find(|row| row.id == item.id)
        .and_then(|row| row.project);

    print_delete_summary(&item, project.as_deref());
    if !confirm_delete()? {
        println!("Canceled.");
        return Ok(());
    }

    let report = monica_core::delete_issue(&mut runtime.repositories, &runtime.git, id)?;
    println!("Deleted issue {}.", report.item.id);
    if !report.task_runs.is_empty() {
        println!("Preserved task runs: {}.", report.task_runs.join(", "));
    }
    if !report.removed_branches.is_empty() {
        println!("Removed branches: {}.", report.removed_branches.join(", "));
    }
    Ok(())
}

fn print_delete_summary(item: &Task, project: Option<&str>) {
    println!("Delete issue?");
    println!();
    println!("  ID:      {}", item.id);
    println!("  Title:   {}", item.title);
    println!("  Status:  {}", item.status.as_str());
    println!("  Project: {}", project.unwrap_or("-"));
    println!();
    println!("This cannot be undone.");
}

fn confirm_delete() -> Result<bool> {
    print!("Continue? [y/N] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(is_yes(answer.trim()))
}

fn is_yes(answer: &str) -> bool {
    answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
}

fn mark_command(runtime: &mut Runtime, id: &str, status: &str, note: Option<&str>) -> Result<()> {
    let status = TaskStatus::parse_token(status)?;
    monica_core::mark_issue(&mut runtime.repositories, id, status, note)?;
    println!("Marked {id} as {}", status.as_str());
    if let Some(note) = note {
        println!("Note: {note}");
    }
    Ok(())
}

fn parse_status_filter(status: Option<&str>) -> Result<Option<DisplayStatus>> {
    status.map(DisplayStatus::parse_token).transpose()
}

fn normalize_project_filter(project: Option<&str>) -> Result<Option<String>> {
    project.map(parse_owner_repo).transpose()
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
        table.push(vec![
            row.id.clone(),
            display_opt(row.project.as_deref()),
            row.github_issue_number
                .map(|n| format!("#{n}"))
                .unwrap_or_else(|| "-".to_string()),
            row.status.as_str().to_string(),
            display_opt(row.branch.as_deref()),
        ]);
    }
    render_table(&table)
}

fn render_table(rows: &[Vec<String>]) -> String {
    let cols = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    if cols == 0 {
        return String::new();
    }
    let mut widths = vec![0usize; cols];
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }

    let mut out = String::new();
    for row in rows {
        let line = row
            .iter()
            .enumerate()
            .map(|(i, cell)| format!("{cell:<width$}", width = widths[i]))
            .collect::<Vec<_>>()
            .join("  ");
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn display_opt(value: Option<&str>) -> String {
    value.unwrap_or("-").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_filter_validates_enum() {
        assert_eq!(
            parse_status_filter(Some("ready")).unwrap(),
            Some(DisplayStatus::Ready)
        );
        assert!(parse_status_filter(Some("bogus")).is_err());
        assert_eq!(parse_status_filter(None).unwrap(), None);
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
    fn is_yes_accepts_only_explicit_yes() {
        assert!(is_yes("y"));
        assert!(is_yes("Y"));
        assert!(is_yes("yes"));
        assert!(is_yes("YES"));
        assert!(!is_yes(""));
        assert!(!is_yes("n"));
        assert!(!is_yes("yeah"));
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
            status: DisplayStatus::Ready,
            branch: Some("monica/gh-17".to_string()),
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
