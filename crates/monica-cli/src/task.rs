use std::io::{self, Write};

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_application::{
    parse_issue_input, parse_pull_request_input, AttachSessionReport, CurrentTaskReport,
    GithubIssueState, GithubPullRequestStatus, GithubSyncReport, IssueBlocker, RunTaskResult,
    TabIdentity, TaskSummaryRow, TaskSyncChange, TrackOutcome,
};
use monica_domain::{parse_owner_repo, Agent, DisplayStatus, RunMode, TaskId};

use crate::event_sink::{self, CliFacade};
use crate::table::{or_dash, render_table};

#[derive(Subcommand)]
pub enum TaskCommand {
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
    /// Link a pull request (owner/repo#123 or PR URL) to a tracked task
    Pr {
        /// MON-<id>
        id: String,
        /// owner/repo#123 or GitHub pull request URL
        target: String,
    },
    /// Launch (or resume) the task's Main Run; Monica opens a Claude tab in its runspace
    Run {
        /// MON-<id>
        id: String,
        /// Run in the project checkout instead of preparing a worktree
        #[arg(long)]
        in_place: bool,
        /// Start even though an issue blocking this one is still unfinished
        #[arg(long)]
        force: bool,
    },
    /// Connect this terminal tab's agent session to an existing task (MON-<id>)
    Attach {
        /// MON-<id>
        id: String,
    },
    /// Show the task this terminal tab is working on
    Current {
        /// Emit machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Close a tracked Monica task (MON-<id>)
    Close {
        /// MON-<id>
        id: String,
    },
    /// Refresh tracked tasks from GitHub and report what changed
    Sync {
        /// MON-<id>; omit to sync every open task
        id: Option<String>,
    },
}

pub async fn run(cmd: TaskCommand) -> Result<()> {
    let mut monica = event_sink::open()?;
    match cmd {
        TaskCommand::Track { target } => track_command(&mut monica, &target).await,
        TaskCommand::Status { status, project } => status_command(&mut monica, status, project),
        TaskCommand::Pr { id, target } => pr_command(&mut monica, &id, &target).await,
        TaskCommand::Run { id, in_place, force } => {
            run_command(&mut monica, &id, in_place, force).await
        }
        TaskCommand::Attach { id } => attach_command(&mut monica, &id),
        TaskCommand::Current { json } => current_command(&mut monica, json),
        TaskCommand::Close { id } => close_command(&mut monica, &id),
        TaskCommand::Sync { id } => sync_command(&mut monica, id.as_deref()).await,
    }
}

async fn track_command(monica: &mut CliFacade, target: &str) -> Result<()> {
    let (repo, number) = parse_issue_input(target)?;
    let report = monica
        .synchronization()
        .track_github_issue(repo.clone(), number)
        .await
        .with_context(|| format!("failed to fetch GitHub issue {repo}#{number}"))?;
    let task = report.task;
    let issue = report.issue;
    match report.outcome {
        TrackOutcome::Created => println!("Created {} from {}#{}", task.id, repo, issue.number),
        TrackOutcome::AlreadyTracked => {
            println!("Already tracked as {} from {}#{}", task.id, repo, issue.number)
        }
    }
    println!("Status: {}", task.status.as_str());
    println!("Title: {}", task.title);
    Ok(())
}

async fn pr_command(monica: &mut CliFacade, id: &str, target: &str) -> Result<()> {
    let task_id = TaskId::parse(id)?;
    let (repo, number) = parse_pull_request_input(target)?;
    let report = monica
        .synchronization()
        .link_pull_request(&task_id, repo.clone(), number)
        .await
        .with_context(|| format!("failed to link GitHub pull request {repo}#{number}"))?;
    let pr = report.pull_request;
    println!(
        "Linked {}#{} ({}) to {}.",
        pr.repo,
        pr.number,
        pr.status.as_str(),
        report.task.id
    );
    println!("Task: {}", report.task.title);
    println!("URL: {}", pr.url);
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

async fn sync_command(monica: &mut CliFacade, id: Option<&str>) -> Result<()> {
    // The façade treats an unauthenticated sync as a no-op so the board can navigate into one on
    // every visit; a CLI invocation is deliberate, so say why nothing would happen instead.
    let auth = monica.synchronization().auth_status();
    if !auth.authenticated {
        return Err(anyhow!(
            "GitHub is not authenticated: {}",
            auth.message
                .as_deref()
                .unwrap_or("run `gh auth login`, then retry")
        ));
    }

    let task_id = id.map(TaskId::parse).transpose()?;
    let report = monica
        .synchronization()
        .sync_github_with_report(task_id.as_ref())
        .await?;
    print!("{}", render_sync_report(&report));
    // A pass that could not read a repo still returns what it did manage to write, which is the
    // right call for the board. A script — `monica task sync && monica task status` — must not
    // read that as fresh, so an unreachable repo fails the command after showing the partial work.
    if !report.is_complete() {
        return Err(anyhow!(
            "GitHub fetch failed for {}; the results above are partial and those repos kept their \
             previous values",
            report.failed_repos.join(", ")
        ));
    }
    Ok(())
}

fn render_sync_report(report: &GithubSyncReport) -> String {
    if report.is_unchanged() {
        return format!("Synced {} refs; no changes.\n", report.synced_count);
    }

    let counts = report.counts();
    let mut out = format!(
        "Synced {} refs; {} changes (title {}, state {}, pr {}, parent {})\n",
        report.synced_count,
        counts.total(),
        counts.title,
        counts.issue_state,
        counts.pull_request,
        counts.parent,
    );

    // One row per change with a fixed column shape — task, kind, the PR it concerns, before,
    // after — so an agent reading this can split on whitespace instead of parsing prose.
    let mut table = Vec::new();
    for task in &report.tasks {
        for change in &task.changes {
            let (kind, reference, before, after) = match change {
                TaskSyncChange::Title { before, after } => {
                    ("title", dash(), before.clone(), after.clone())
                }
                TaskSyncChange::IssueState { before, after } => (
                    "state",
                    dash(),
                    or_dash(before.map(GithubIssueState::as_str)),
                    or_dash(after.map(GithubIssueState::as_str)),
                ),
                TaskSyncChange::PullRequest {
                    repo,
                    number,
                    before,
                    after,
                } => (
                    "pr",
                    format!("{repo}#{number}"),
                    or_dash(before.map(GithubPullRequestStatus::as_str)),
                    or_dash(after.map(GithubPullRequestStatus::as_str)),
                ),
                TaskSyncChange::Parent { before, after } => (
                    "parent",
                    dash(),
                    or_dash(before.as_deref()),
                    or_dash(after.as_deref()),
                ),
            };
            table.push(vec![
                task.task_id.clone(),
                kind.to_string(),
                reference,
                before,
                "->".to_string(),
                after,
            ]);
        }
    }
    out.push_str(&render_table(&table));
    out
}

/// The `-` the table uses for a column a given change kind has nothing to put in.
fn dash() -> String {
    or_dash(None)
}

async fn run_command(
    monica: &mut CliFacade,
    id: &str,
    in_place: bool,
    force: bool,
) -> Result<()> {
    let task_id = TaskId::parse(id)?;
    let mode = if in_place { RunMode::InPlace } else { RunMode::Worktree };
    // The start gate reads a mirror of GitHub, and outside the desktop nothing else refreshes it:
    // the background sync worker only runs in the app. Without this, a task tracked before its
    // blocker existed — or before this feature shipped at all — would keep an empty blocker list
    // and start regardless. Refreshed here rather than inside the gate so `--force` pays nothing.
    //
    // Best-effort on purpose: offline, the run still goes ahead on whatever the mirror last knew,
    // which is no worse than before. An unauthenticated façade makes this a no-op already.
    if !force {
        if let Err(e) = monica.synchronization().force_sync_github(Some(&task_id)).await {
            eprintln!("monica: could not refresh {task_id} from GitHub ({e:#}); using the last sync");
        }
    }
    // Setup can take minutes and launch_task blocks through it, so say so up front — but not when
    // the start gate is about to refuse, or the announcement would promise work that never starts.
    let summaries = monica.tasks().list_all_task_summaries(None)?;
    let row = summaries.iter().find(|row| row.id == task_id.as_str());
    let gate_will_refuse =
        !force && row.is_some_and(|row| !row.blockers.iter().all(IssueBlocker::is_cleared));
    let needs_prepare = mode == RunMode::Worktree
        && !gate_will_refuse
        && row.is_some_and(|row| row.run_needs_prepare);
    if needs_prepare {
        println!("Preparing a worktree and running setup for {task_id} ...");
        io::stdout().flush()?;
        forward_ctrl_c_to_setup();
    }
    let launch = monica.executions().launch_task(&task_id, None, mode, force)?;
    print!("{}", render_run_report(&launch));
    Ok(())
}

/// The setup script runs in its own process group so a timeout can kill its whole tree, which also
/// keeps the terminal's Ctrl-C from reaching it. Hand the interrupt on so an aborted `task run`
/// takes its setup down with it and the run ends `failed` instead of an orphaned script keeping
/// the task stuck at `setting_up`.
#[cfg(unix)]
fn forward_ctrl_c_to_setup() {
    extern "C" fn on_sigint(_: libc::c_int) {
        monica_runtime::request_setup_interrupt();
    }
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(
            libc::SIGINT,
            on_sigint as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
    }
}

#[cfg(not(unix))]
fn forward_ctrl_c_to_setup() {}

fn render_run_report(launch: &RunTaskResult) -> String {
    format!(
        "Launched {} ({}) in {}\nMonica opens a Claude tab in the task's runspace.\n",
        launch.task_id, launch.task_run_id, launch.cwd
    )
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// The `MONICA_*` identity this shell was started with. The acceptance rules live in
/// `TabIdentity`, so `attach` and `current` agree on what counts as a Monica tab.
fn tab_identity() -> TabIdentity {
    TabIdentity {
        task_id: env_opt("MONICA_TASK_ID"),
        terminal_tab_id: env_opt("MONICA_TERMINAL_TAB_ID"),
        terminal_session_id: env_opt("MONICA_TERMINAL_SESSION_ID"),
    }
}

fn attach_command(monica: &mut CliFacade, id: &str) -> Result<()> {
    let identity = tab_identity();
    let (terminal_tab_id, terminal_session_id) = identity.attach_target()?;
    let task_id = TaskId::parse(id)?;
    // The shell's current directory, not the session's spawn directory: the user may have `cd`ed
    // since, and the bench should open where they actually are.
    let cwd = std::env::current_dir()
        .context("failed to read the current directory")?
        .to_string_lossy()
        .into_owned();
    let report = monica.tasks().attach_terminal_session(
        &task_id,
        Agent::Claude,
        terminal_tab_id,
        terminal_session_id,
        &cwd,
    )?;
    print!("{}", render_attach_report(&report));
    Ok(())
}

fn current_command(monica: &mut CliFacade, json: bool) -> Result<()> {
    let report = monica.tasks().current_task(&tab_identity())?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    print!("{}", render_current_report(&report));
    Ok(())
}

fn render_current_report(report: &CurrentTaskReport) -> String {
    let issue = report.github_issue_number.map(|number| format!("#{number}"));
    let run = report.task_run_id.as_ref().map(|id| {
        let status = report
            .task_run_status
            .map(|status| status.as_str())
            .unwrap_or("-");
        format!("{id} ({status})")
    });
    let mut out = format!("{}\n", report.task_id);
    out.push_str(&format!("  Title:   {}\n", report.title));
    out.push_str(&format!("  Project: {}\n", or_dash(report.project.as_deref())));
    out.push_str(&format!("  Issue:   {}\n", or_dash(issue.as_deref())));
    out.push_str(&format!("  Status:  {}\n", report.status.as_str()));
    out.push_str(&format!("  Run:     {}\n", or_dash(run.as_deref())));
    out.push_str(&format!("  Source:  {}\n", report.source.as_str()));
    out
}

fn render_attach_report(report: &AttachSessionReport) -> String {
    let mut out = format!("Attached {} to this terminal tab.\n", report.task_id);
    out.push_str(&format!("  Task:    {}\n", report.task_title));
    out.push_str(&format!("  Run:     {}\n", report.task_run_id));
    out.push_str(&format!(
        "  Session: {}\n",
        or_dash(report.agent_session_id.as_deref())
    ));
    match &report.kept_primary_run_id {
        None => out.push_str("  Main Run: yes\n"),
        Some(kept) => out.push_str(&format!("  Main Run: kept {kept} (mid-prepare)\n")),
    }
    if !report.detached_run_ids.is_empty() {
        let ids: Vec<&str> = report.detached_run_ids.iter().map(|id| id.as_str()).collect();
        out.push_str(&format!("  Detached previous runs: {}\n", ids.join(", ")));
    }
    out.push_str("The tab moves into the task's runspace in Monica.\n");
    out
}

fn close_command(monica: &mut CliFacade, id: &str) -> Result<()> {
    let task = monica
        .tasks()
        .list_all_task_summaries(None)?
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| anyhow!("Task not found: {id}"))?;

    print_close_summary(&task);
    if !confirm_close()? {
        println!("Canceled.");
        return Ok(());
    }

    let report = monica.tasks().close_task(&TaskId::from_store(id.to_string()))?;
    println!("Closed task {}.", report.task.id);
    if !report.task_runs.is_empty() {
        println!("Preserved task runs: {}.", report.task_runs.join(", "));
    }
    if !report.removed_branches.is_empty() {
        println!("Removed branches: {}.", report.removed_branches.join(", "));
    }
    Ok(())
}

fn print_close_summary(task: &TaskSummaryRow) {
    println!("Close task?");
    println!();
    println!("  ID:      {}", task.id);
    println!("  Title:   {}", task.title);
    println!("  Status:  {}", task.task_status.as_str());
    println!("  Project: {}", task.project.as_deref().unwrap_or("-"));
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
        return "No tracked tasks found.\n".to_string();
    }

    let mut table = vec![vec![
        "ID".to_string(),
        "PARENT".to_string(),
        "PROJECT".to_string(),
        "GH ISSUE".to_string(),
        "STATUS".to_string(),
        "BLOCKED BY".to_string(),
        "BRANCH".to_string(),
    ]];
    for row in rows {
        let github_issue = row.github_issue_number.map(|n| format!("#{n}"));
        let blocked_by = render_blockers(&row.blockers);
        table.push(vec![
            row.id.clone(),
            or_dash(row.parent_task_id.as_deref()),
            or_dash(row.project.as_deref()),
            or_dash(github_issue.as_deref()),
            row.status.as_str().to_string(),
            or_dash(blocked_by.as_deref()),
            or_dash(row.branch.as_deref()),
        ]);
    }
    render_table(&table)
}

/// Only the blockers that still block, each named by [`IssueBlocker::label`] so the column and the
/// refusal `monica task run` prints agree on which issue is which. Joined without a space: a cell
/// here has to stay one whitespace-delimited token, the way the rest of this table reads.
fn render_blockers(blockers: &[IssueBlocker]) -> Option<String> {
    let unresolved: Vec<String> = blockers
        .iter()
        .filter(|blocker| !blocker.is_cleared())
        .map(IssueBlocker::label)
        .collect();
    (!unresolved.is_empty()).then(|| unresolved.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_application::{CurrentTaskSource, TaskSyncChanges};
    use monica_domain::TaskStatus;

    #[test]
    fn render_current_report_lays_out_the_fields_a_skill_reads() {
        let rendered = render_current_report(&CurrentTaskReport {
            task_id: "MON-42".to_string(),
            title: "orchestration session".to_string(),
            project: Some("ashigirl96/monica".to_string()),
            github_issue_number: Some(519),
            github_issue_url: None,
            task_status: TaskStatus::InProgress,
            status: DisplayStatus::Running,
            task_run_id: Some("run-73".to_string()),
            task_run_status: Some(monica_domain::TaskRunStatus::Running),
            source: CurrentTaskSource::Tab,
        });
        assert_eq!(
            rendered,
            "MON-42\n\
             \x20 Title:   orchestration session\n\
             \x20 Project: ashigirl96/monica\n\
             \x20 Issue:   #519\n\
             \x20 Status:  running\n\
             \x20 Run:     run-73 (running)\n\
             \x20 Source:  tab\n"
        );
    }

    #[test]
    fn render_current_report_dashes_a_task_with_no_issue_project_or_run() {
        let rendered = render_current_report(&CurrentTaskReport {
            task_id: "MON-7".to_string(),
            title: "raw task".to_string(),
            project: None,
            github_issue_number: None,
            github_issue_url: None,
            task_status: TaskStatus::Ready,
            status: DisplayStatus::Ready,
            task_run_id: None,
            task_run_status: None,
            source: CurrentTaskSource::Env,
        });
        assert!(rendered.contains("  Project: -\n"), "{rendered}");
        assert!(rendered.contains("  Issue:   -\n"), "{rendered}");
        assert!(rendered.contains("  Run:     -\n"), "{rendered}");
        assert!(rendered.contains("  Source:  env\n"), "{rendered}");
    }

    #[test]
    fn render_run_report_names_the_run_and_where_it_opens() {
        let rendered = render_run_report(&RunTaskResult {
            task_id: TaskId::from_store("MON-42".to_string()),
            task_run_id: monica_domain::TaskRunId::from_store("run-73".to_string()),
            runspace_id: monica_domain::RunspaceId::from_store("bench-MON-42".to_string()),
            cwd: "/repo/.worktrees/mon-42".to_string(),
            env: Vec::new(),
            initial_command: "claude".to_string(),
        });
        assert_eq!(
            rendered,
            "Launched MON-42 (run-73) in /repo/.worktrees/mon-42\n\
             Monica opens a Claude tab in the task's runspace.\n"
        );
    }

    #[test]
    fn render_attach_report_shows_detached_runs_only_when_there_are_any() {
        let mut report = AttachSessionReport {
            task_id: TaskId::from_store("MON-42".to_string()),
            task_title: "orchestration session".to_string(),
            task_run_id: monica_domain::TaskRunId::from_store("run-73".to_string()),
            agent_session_id: None,
            detached_run_ids: Vec::new(),
            runspace_id: monica_domain::RunspaceId::from_store("bench-MON-42".to_string()),
            kept_primary_run_id: None,
        };
        let rendered = render_attach_report(&report);
        assert!(rendered.contains("Attached MON-42"));
        assert!(rendered.contains("run-73"));
        assert!(rendered.contains("Session: -"), "{rendered}");
        assert!(rendered.contains("Main Run: yes"), "{rendered}");
        assert!(!rendered.contains("Detached"), "{rendered}");

        report.detached_run_ids =
            vec![monica_domain::TaskRunId::from_store("run-70".to_string())];
        assert!(render_attach_report(&report).contains("Detached previous runs: run-70"));
    }

    #[test]
    fn render_attach_report_names_the_primary_it_left_in_place() {
        let report = AttachSessionReport {
            task_id: TaskId::from_store("MON-42".to_string()),
            task_title: "orchestration session".to_string(),
            task_run_id: monica_domain::TaskRunId::from_store("run-73".to_string()),
            agent_session_id: None,
            detached_run_ids: Vec::new(),
            runspace_id: monica_domain::RunspaceId::from_store("bench-MON-42".to_string()),
            kept_primary_run_id: Some(monica_domain::TaskRunId::from_store("run-70".to_string())),
        };
        let rendered = render_attach_report(&report);
        assert!(rendered.contains("Main Run: kept run-70 (mid-prepare)"), "{rendered}");
        assert!(!rendered.contains("Main Run: yes"), "{rendered}");
    }

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

    fn summary_row() -> TaskSummaryRow {
        TaskSummaryRow {
            parent_task_id: Some("MON-9".to_string()),
            id: "MON-1".to_string(),
            title: "Test issue".to_string(),
            project: Some("ashigirl96/monica".to_string()),
            github_issue_number: Some(17),
            github_issue_url: Some("https://github.com/ashigirl96/monica/issues/17".to_string()),
            github_issue_state: Some(GithubIssueState::Open),
            github_pull_requests: Vec::new(),
            blockers: Vec::new(),
            task_status: TaskStatus::Ready,
            task_run_status: None,
            task_run_wait_reason: None,
            has_plan: false,
            status: DisplayStatus::Ready,
            prepare_eligible: true,
            run_eligible: true,
            run_needs_prepare: true,
            attach_eligible: true,
            is_active: false,
            has_open_pull_request: false,
            branch: Some("monica/gh-17".to_string()),
            side_runs_running: 0,
            side_runs_waiting_for_user: 0,
            side_runs_failed: 0,
        }
    }

    /// The cell under `PARENT` on the single data row.
    fn parent_cell(rendered: &str) -> String {
        rendered.lines().nth(1).unwrap().split_whitespace().nth(1).unwrap().to_string()
    }

    #[test]
    fn render_status_table_formats_rows_and_empty_state() {
        let rendered = render_status_table(&[summary_row()]);
        assert!(rendered.contains("ID"));
        assert!(rendered.contains("PARENT"));
        assert_eq!(parent_cell(&rendered), "MON-9");
        assert!(rendered.contains("ashigirl96/monica"));
        assert!(rendered.contains("#17"));
        assert!(rendered.contains("BRANCH"));
        assert!(!rendered
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .any(|column| column == "PR"));

        assert_eq!(render_status_table(&[]), "No tracked tasks found.\n");
    }

    #[test]
    fn render_status_table_dashes_a_task_without_a_parent() {
        let row = TaskSummaryRow { parent_task_id: None, ..summary_row() };
        assert_eq!(parent_cell(&render_status_table(&[row])), "-");
    }

    fn blocker(number: i64, state: GithubIssueState, merged_pr: bool) -> IssueBlocker {
        IssueBlocker {
            address: monica_application::IssueAddress {
                repo: "ashigirl96/monica".to_string(),
                number,
            },
            state,
            closed_by_merged_pull_request: merged_pr,
            reopened: false,
        }
    }

    #[test]
    fn the_blocked_by_column_lists_only_what_still_blocks() {
        // The column has to agree with the refusal `monica task run` prints, so it narrows the
        // stored blockers through the same rule the gate uses.
        assert_eq!(
            render_blockers(&[
                blocker(7, GithubIssueState::Open, false),
                blocker(8, GithubIssueState::Closed, false),
                blocker(9, GithubIssueState::Open, true),
                blocker(10, GithubIssueState::Open, false),
            ])
            .as_deref(),
            Some("ashigirl96/monica#7,ashigirl96/monica#10")
        );
    }

    #[test]
    fn the_blocked_by_column_is_empty_when_nothing_blocks() {
        assert_eq!(render_blockers(&[]), None);
        assert_eq!(render_blockers(&[blocker(8, GithubIssueState::Closed, false)]), None);
    }

    #[test]
    fn render_status_table_shows_the_blockers_that_hold_a_task_back() {
        let row = TaskSummaryRow {
            blockers: vec![blocker(7, GithubIssueState::Open, false)],
            ..summary_row()
        };
        let rendered = render_status_table(&[row]);
        assert!(rendered.contains("BLOCKED BY"), "{rendered}");
        assert!(rendered.contains("ashigirl96/monica#7"), "{rendered}");
    }

    #[test]
    fn render_sync_report_lists_every_change_kind_in_fixed_columns() {
        let report = GithubSyncReport {
            synced_count: 14,
            failed_repos: Vec::new(),
            tasks: vec![
                TaskSyncChanges {
                    task_id: "MON-42".to_string(),
                    changes: vec![
                        TaskSyncChange::Title {
                            before: "Old title".to_string(),
                            after: "New title".to_string(),
                        },
                        TaskSyncChange::IssueState {
                            before: Some(GithubIssueState::Open),
                            after: Some(GithubIssueState::Closed),
                        },
                    ],
                },
                TaskSyncChanges {
                    task_id: "MON-51".to_string(),
                    changes: vec![
                        TaskSyncChange::PullRequest {
                            repo: "ashigirl96/monica".to_string(),
                            number: 489,
                            before: Some(GithubPullRequestStatus::Open),
                            after: Some(GithubPullRequestStatus::Merged),
                        },
                        TaskSyncChange::Parent {
                            before: None,
                            after: Some("MON-42".to_string()),
                        },
                    ],
                },
            ],
        };

        let rendered = render_sync_report(&report);
        let mut lines = rendered.lines();
        assert_eq!(
            lines.next().unwrap(),
            "Synced 14 refs; 4 changes (title 1, state 1, pr 1, parent 1)"
        );

        let cells = |line: &str| -> Vec<String> {
            line.split_whitespace().map(str::to_string).collect()
        };
        let title = cells(lines.next().unwrap());
        assert_eq!(title[0], "MON-42");
        assert_eq!(title[1], "title");
        assert_eq!(title[2], "-", "only a PR change carries a ref");

        let state = cells(lines.next().unwrap());
        assert_eq!(state[1], "state");
        assert_eq!((state[3].as_str(), state[5].as_str()), ("open", "closed"));

        let pr = cells(lines.next().unwrap());
        assert_eq!(pr[0], "MON-51");
        assert_eq!(pr[1], "pr");
        assert_eq!(pr[2], "ashigirl96/monica#489");
        assert_eq!((pr[3].as_str(), pr[5].as_str()), ("open", "merged"));

        let parent = cells(lines.next().unwrap());
        assert_eq!(parent[1], "parent");
        assert_eq!((parent[3].as_str(), parent[5].as_str()), ("-", "MON-42"));
        assert!(lines.next().is_none());
    }

    #[test]
    fn render_sync_report_collapses_an_unchanged_sync_to_one_line() {
        let report = GithubSyncReport {
            synced_count: 14,
            ..GithubSyncReport::default()
        };
        assert_eq!(render_sync_report(&report), "Synced 14 refs; no changes.\n");
        assert_eq!(
            render_sync_report(&GithubSyncReport::default()),
            "Synced 0 refs; no changes.\n"
        );
    }
}
