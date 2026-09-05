use std::io::{self, Write};

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_application::{
    parse_issue_input, parse_pull_request_input, AttachSessionReport, GithubIssueState,
    GithubPullRequestStatus, GithubSyncReport, TaskSummaryRow, TaskSyncChange, TrackOutcome,
};
use monica_domain::{parse_owner_repo, Agent, DisplayStatus, TaskId};

use crate::event_sink::{self, CliFacade};

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
    /// Connect this terminal tab's agent session to an existing task (MON-<id>)
    Attach {
        /// MON-<id>
        id: String,
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
        TaskCommand::Attach { id } => attach_command(&mut monica, &id),
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

    let task_id = id.map(|id| resolve_task_id(monica, id)).transpose()?;
    let report = monica
        .synchronization()
        .force_sync_github(task_id.as_ref())
        .await
        .context("failed to sync with GitHub")?;
    print!("{}", render_sync_report(&report));
    Ok(())
}

fn resolve_task_id(monica: &mut CliFacade, id: &str) -> Result<TaskId> {
    let task_id = TaskId::parse(id)?;
    let exists = monica
        .tasks()
        .list_all_task_summaries(None)?
        .iter()
        .any(|row| row.id == id);
    exists
        .then_some(task_id)
        .ok_or_else(|| anyhow!("Task not found: {id}"))
}

fn render_sync_report(report: &GithubSyncReport) -> String {
    if report.is_unchanged() {
        return format!("Synced {} refs; no changes.\n", report.synced_count);
    }

    let counts = report.counts();
    let mut out = format!(
        "Synced {} refs; {} changes (title {}, state {}, pr {}, parent {})\n",
        report.synced_count,
        report.change_count(),
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
                    ("title", None, before.clone(), after.clone())
                }
                TaskSyncChange::IssueState { before, after } => (
                    "state",
                    None,
                    crate::table::or_dash(before.map(GithubIssueState::as_str)),
                    crate::table::or_dash(after.map(GithubIssueState::as_str)),
                ),
                TaskSyncChange::PullRequest {
                    repo,
                    number,
                    before,
                    after,
                } => (
                    "pr",
                    Some(format!("{repo}#{number}")),
                    crate::table::or_dash(before.map(GithubPullRequestStatus::as_str)),
                    crate::table::or_dash(after.map(GithubPullRequestStatus::as_str)),
                ),
                TaskSyncChange::Parent { before, after } => (
                    "parent",
                    None,
                    crate::table::or_dash(before.as_deref()),
                    crate::table::or_dash(after.as_deref()),
                ),
            };
            table.push(vec![
                task.task_id.clone(),
                kind.to_string(),
                crate::table::or_dash(reference.as_deref()),
                before,
                "->".to_string(),
                after,
            ]);
        }
    }
    out.push_str(&crate::table::render_table(&table));
    out
}

/// The `MONICA_*` identity a tab burns into its shell env, as `attach` needs it.
#[derive(Debug, PartialEq, Eq)]
struct AttachEnv {
    terminal_tab_id: String,
    terminal_session_id: String,
}

/// Validate the ambient tab identity before attaching. A tab carrying `MONICA_TASK_ID` is already
/// bound to that task and its hooks resolve through the task-scoped rules, so a run attached here
/// would never receive one — refuse instead of leaving a silently dead binding behind.
fn attach_env_from(
    task_id: Option<&str>,
    tab_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<AttachEnv> {
    if let Some(task_id) = task_id {
        return Err(anyhow!(
            "this tab is already bound to task {task_id}; attach is for tabs started outside a task"
        ));
    }
    let (Some(terminal_tab_id), Some(terminal_session_id)) = (tab_id, session_id) else {
        return Err(anyhow!(
            "no Monica terminal tab detected; run this inside a Monica terminal tab"
        ));
    };
    Ok(AttachEnv {
        terminal_tab_id: terminal_tab_id.to_string(),
        terminal_session_id: terminal_session_id.to_string(),
    })
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn attach_command(monica: &mut CliFacade, id: &str) -> Result<()> {
    let env = attach_env_from(
        env_opt("MONICA_TASK_ID").as_deref(),
        env_opt("MONICA_TERMINAL_TAB_ID").as_deref(),
        env_opt("MONICA_TERMINAL_SESSION_ID").as_deref(),
    )?;
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
        &env.terminal_tab_id,
        &env.terminal_session_id,
        &cwd,
    )?;
    print!("{}", render_attach_report(&report));
    Ok(())
}

fn render_attach_report(report: &AttachSessionReport) -> String {
    let mut out = format!("Attached {} to this terminal tab.\n", report.task_id);
    out.push_str(&format!("  Task:    {}\n", report.task_title));
    out.push_str(&format!("  Run:     {}\n", report.task_run_id));
    out.push_str(&format!(
        "  Session: {}\n",
        crate::table::or_dash(report.agent_session_id.as_deref())
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
        "BRANCH".to_string(),
    ]];
    for row in rows {
        let github_issue = row.github_issue_number.map(|n| format!("#{n}"));
        table.push(vec![
            row.id.clone(),
            crate::table::or_dash(row.parent_task_id.as_deref()),
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
    use monica_application::TaskSyncChanges;
    use monica_domain::TaskStatus;

    #[test]
    fn attach_env_reads_the_tab_identity_from_a_task_less_tab() {
        assert_eq!(
            attach_env_from(None, Some("tab-1"), Some("ts-9")).unwrap(),
            AttachEnv {
                terminal_tab_id: "tab-1".to_string(),
                terminal_session_id: "ts-9".to_string(),
            }
        );
    }

    #[test]
    fn attach_env_refuses_a_tab_already_bound_to_a_task() {
        // Such a tab's hooks resolve through the task-scoped rules and would never reach a run
        // attached here, so the binding would be silently dead.
        let err = attach_env_from(Some("MON-7"), Some("tab-1"), Some("ts-9")).unwrap_err();
        assert!(err.to_string().contains("MON-7"), "{err}");
    }

    #[test]
    fn attach_env_refuses_a_shell_outside_a_monica_tab() {
        for (tab, session) in [(None, Some("ts-9")), (Some("tab-1"), None), (None, None)] {
            let err = attach_env_from(None, tab, session).unwrap_err();
            assert!(
                err.to_string().contains("Monica terminal tab"),
                "{err} (tab={tab:?}, session={session:?})"
            );
        }
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

    #[test]
    fn render_sync_report_lists_every_change_kind_in_fixed_columns() {
        let report = GithubSyncReport {
            synced_count: 14,
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
            tasks: Vec::new(),
        };
        assert_eq!(render_sync_report(&report), "Synced 14 refs; no changes.\n");
        assert_eq!(
            render_sync_report(&GithubSyncReport::default()),
            "Synced 0 refs; no changes.\n"
        );
    }
}
