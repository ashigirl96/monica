use std::io::{self, Write};
use std::process::Command;
use std::str::FromStr;

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_core::{
    parse_issue_ref, parse_owner_repo, track_github_issue, Agent, AgentLaunchMode, Db,
    DisplayStatus, GithubIssue, SetupOutcome, Task, TaskRunStatus, TaskStatus, TaskSummaryRow,
};
use serde::Deserialize;

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
        /// Skip the confirmation prompt
        #[arg(short = 'y', long)]
        yes: bool,
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
        /// PR URL to record as a github_pull_request reference
        #[arg(long = "pr-url")]
        pr_url: Option<String>,
    },
}

pub fn run(cmd: IssueCommand) -> Result<()> {
    let mut db = Db::open()?;
    match cmd {
        IssueCommand::Track { target } => track_command(&mut db, &target),
        IssueCommand::Status { status, project } => status_command(&db, status, project),
        IssueCommand::Run {
            id,
            claude,
            agent,
            continue_session,
            fork,
        } => run_command(
            &mut db,
            &id,
            claude,
            agent.as_deref(),
            continue_session,
            fork.as_deref(),
        ),
        IssueCommand::Delete { id, yes } => delete_command(&mut db, &id, yes),
        IssueCommand::Mark {
            id,
            status,
            note,
            pr_url,
        } => mark_command(&mut db, &id, &status, note.as_deref(), pr_url.as_deref()),
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

fn status_command(db: &Db, status: Option<String>, project: Option<String>) -> Result<()> {
    let status = parse_status_filter(status.as_deref())?;
    let project = normalize_project_filter(project.as_deref())?;
    let rows = db.list_task_summaries(status, project.as_deref())?;
    print!("{}", render_status_table(&rows));
    Ok(())
}

fn run_command(
    db: &mut Db,
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
    let report = monica_core::run_issue_with_launch_mode(db, id, agent, launch_mode)?;
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
    monica_core::launch_agent(db, &report)
}

fn delete_command(db: &mut Db, id: &str, yes: bool) -> Result<()> {
    let item = db
        .get_task(id)?
        .ok_or_else(|| anyhow!("Issue not found: {id}"))?;
    let project = db
        .list_task_summaries(None, None)?
        .into_iter()
        .find(|row| row.id == item.id)
        .and_then(|row| row.project);

    print_delete_summary(&item, project.as_deref());
    if !yes && !confirm_delete()? {
        println!("Canceled.");
        return Ok(());
    }

    let report = monica_core::delete_issue(db, id)?;
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

fn mark_command(
    db: &mut Db,
    id: &str,
    status: &str,
    note: Option<&str>,
    pr_url: Option<&str>,
) -> Result<()> {
    let status = TaskStatus::parse_token(status)?;
    db.mark_task(id, status, note, pr_url)?;
    println!("Marked {id} as {}", status.as_str());
    if let Some(note) = note {
        println!("Note: {note}");
    }
    if let Some(pr_url) = pr_url {
        println!("PR:   {pr_url}");
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
