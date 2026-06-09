use std::io::{self, Write};
use std::str::FromStr;

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_core::{
    parse_issue_ref, parse_owner_repo, Agent, AgentLaunchMode, DisplayStatus, SetupOutcome, Task,
    TaskRunStatus, TaskStatus, TaskSummaryRow, TrackGithubIssueInput,
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
    /// Create a worktree and run .monica/setup.sh for a task (MON-<id>)
    Run {
        /// MON-<id>
        id: String,
        /// Launch Claude Code after setup (shorthand for --agent claude)
        #[arg(long, conflicts_with = "agent")]
        claude: bool,
        /// Launch a specific agent after setup (e.g. claude)
        #[arg(long, value_name = "AGENT")]
        agent: Option<String>,
        /// Re-enter the most recent Claude Code conversation for this worktree
        #[arg(long = "continue", conflicts_with = "fork")]
        continue_session: bool,
        /// Fork a Claude Code conversation by session id and run it in this worktree
        #[arg(long, value_name = "SESSION_ID", conflicts_with = "continue_session")]
        fork: Option<String>,
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
        IssueCommand::Run {
            id,
            claude,
            agent,
            continue_session,
            fork,
        } => run_command(
            &mut runtime,
            &id,
            claude,
            agent.as_deref(),
            continue_session,
            fork.as_deref(),
        ),
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

fn run_command(
    runtime: &mut Runtime,
    id: &str,
    claude: bool,
    agent: Option<&str>,
    continue_session: bool,
    fork: Option<&str>,
) -> Result<()> {
    let agent = resolve_agent(claude, agent)?;
    let launch_mode = resolve_launch_mode(continue_session, fork)?;
    if launch_mode.is_reconnect() && agent != Some(Agent::Claude) {
        anyhow::bail!("--continue/--fork require --claude or --agent claude");
    }
    let report = monica_core::run_issue_with_launch_mode(
        &mut runtime.repositories,
        &runtime.git,
        &runtime.setup_runner,
        &runtime.run_artifacts,
        id,
        agent,
        launch_mode,
    )?;
    println!("Task run {} for {}", report.task_run_id, report.task_id);
    println!("Branch:   {}", report.branch);
    println!("Worktree: {}", report.worktree_path);
    println!("Setup:    {}", describe_setup(&report.setup));
    println!("Log:      {}", report.log_path);
    println!("Status:   {}", report.status.as_str());
    if let Some(path) = report.settings_path.as_deref() {
        println!("Settings: {path}");
    }
    if report.status == TaskRunStatus::Failed {
        anyhow::bail!(
            "task run {} failed; see {}",
            report.task_run_id,
            report.log_path
        );
    }
    // Hand the terminal to the agent. `launch_agent` is a no-op when no agent was requested, so
    // this call is unconditional. Spawn failure settles the run to failed inside core, so we just
    // propagate.
    monica_core::launch_agent(&mut runtime.repositories, &runtime.agent_launcher, &report)
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

/// Map the two CLI flags (`--claude` shorthand and `--agent <name>`) to an `Option<Agent>`.
/// `conflicts_with` on the clap side guarantees they are never both set, so this only handles the
/// remaining three combinations.
fn resolve_agent(claude: bool, agent: Option<&str>) -> Result<Option<Agent>> {
    match (claude, agent) {
        (false, None) => Ok(None),
        (true, _) => Ok(Some(Agent::Claude)),
        (false, Some(name)) => Ok(Some(Agent::from_str(name)?)),
    }
}

fn resolve_launch_mode(continue_session: bool, fork: Option<&str>) -> Result<AgentLaunchMode> {
    match (continue_session, fork) {
        (false, None) => Ok(AgentLaunchMode::New),
        (true, None) => Ok(AgentLaunchMode::Continue),
        (false, Some(session_id)) if !session_id.trim().is_empty() => Ok(AgentLaunchMode::Fork {
            session_id: session_id.trim().to_string(),
        }),
        (false, Some(_)) => Err(anyhow!("--fork requires a non-empty session id")),
        (true, Some(_)) => Err(anyhow!("--continue and --fork cannot be used together")),
    }
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

fn describe_setup(outcome: &SetupOutcome) -> String {
    match outcome {
        SetupOutcome::Skipped => "skipped (no .monica/setup.sh)".to_string(),
        SetupOutcome::ReusedWorktree => "skipped (reusing existing worktree)".to_string(),
        SetupOutcome::Succeeded => "ok".to_string(),
        SetupOutcome::Failed {
            timed_out: true, ..
        } => "failed (timed out)".to_string(),
        SetupOutcome::Failed {
            code: Some(code), ..
        } => format!("failed (exit {code})"),
        SetupOutcome::Failed { code: None, .. } => "failed".to_string(),
    }
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
    fn describe_setup_covers_outcomes() {
        assert_eq!(
            describe_setup(&SetupOutcome::Skipped),
            "skipped (no .monica/setup.sh)"
        );
        assert_eq!(
            describe_setup(&SetupOutcome::ReusedWorktree),
            "skipped (reusing existing worktree)"
        );
        assert_eq!(describe_setup(&SetupOutcome::Succeeded), "ok");
        assert_eq!(
            describe_setup(&SetupOutcome::Failed {
                code: Some(2),
                timed_out: false
            }),
            "failed (exit 2)"
        );
        assert_eq!(
            describe_setup(&SetupOutcome::Failed {
                code: None,
                timed_out: true
            }),
            "failed (timed out)"
        );
        assert_eq!(
            describe_setup(&SetupOutcome::Failed {
                code: None,
                timed_out: false
            }),
            "failed"
        );
    }

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
    fn resolve_agent_maps_flags_to_optional_agent() {
        assert_eq!(resolve_agent(false, None).unwrap(), None);
        assert_eq!(resolve_agent(true, None).unwrap(), Some(Agent::Claude));
        assert_eq!(
            resolve_agent(false, Some("claude")).unwrap(),
            Some(Agent::Claude)
        );
        assert!(resolve_agent(false, Some("bogus")).is_err());
    }

    #[test]
    fn resolve_launch_mode_maps_continue_and_fork() {
        assert_eq!(
            resolve_launch_mode(false, None).unwrap(),
            AgentLaunchMode::New
        );
        assert_eq!(
            resolve_launch_mode(true, None).unwrap(),
            AgentLaunchMode::Continue
        );
        assert_eq!(
            resolve_launch_mode(false, Some("abc-123")).unwrap(),
            AgentLaunchMode::Fork {
                session_id: "abc-123".to_string()
            }
        );
        assert!(resolve_launch_mode(false, Some("")).is_err());
        assert!(resolve_launch_mode(true, Some("abc-123")).is_err());
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
