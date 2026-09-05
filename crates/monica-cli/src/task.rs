use std::io::{self, Write};

use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use monica_application::{
    parse_issue_input, AttachSessionReport, GithubSyncReport, GithubSyncScope, IssueSyncChange,
    PullRequestSyncChange, TaskSummaryRow, TrackOutcome,
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
    /// Re-fetch GitHub issue / PR state for tracked tasks and report what changed
    Sync {
        /// MON-<id> to sync one task's refs. Defaults to every open task's refs.
        id: Option<String>,
    },
}

pub async fn run(cmd: TaskCommand) -> Result<()> {
    let mut monica = event_sink::open()?;
    match cmd {
        TaskCommand::Track { target } => track_command(&mut monica, &target).await,
        TaskCommand::Status { status, project } => status_command(&mut monica, status, project),
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

async fn sync_command(monica: &mut CliFacade, id: Option<&str>) -> Result<()> {
    let scope = match id {
        Some(id) => GithubSyncScope::Task(resolve_task_id(monica, id)?),
        None => GithubSyncScope::All,
    };
    let report = monica.synchronization().sync_github(scope).await?;
    print!("{}", render_sync_report(&report));
    if report.unrefreshed.is_empty() {
        return Ok(());
    }
    Err(anyhow!("{}", incomplete_sync_message(&report.unrefreshed)))
}

/// Reject an unknown task here rather than letting the sync report zero refs, which reads the same
/// as a typo'd id having nothing to refresh.
fn resolve_task_id(monica: &mut CliFacade, id: &str) -> Result<String> {
    let task_id = TaskId::parse(id)?;
    monica
        .tasks()
        .get_task(&task_id)?
        .map(|task| task.id.into_string())
        .ok_or_else(|| anyhow!("Task not found: {id}"))
}

/// Anything the sync could not refresh keeps whatever was cached, so the command must fail rather
/// than let `monica task sync && monica task status` read stale rows as fresh ones.
fn incomplete_sync_message(unrefreshed: &[String]) -> String {
    format!(
        "sync incomplete: could not refresh {}; those refs still show what was cached before",
        unrefreshed.join(", ")
    )
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

fn render_sync_report(report: &GithubSyncReport) -> String {
    let changed = report.changed_count();
    if changed == 0 {
        return match (report.synced_count, report.unrefreshed.is_empty()) {
            // Nothing came back at all: the error carries the reason, so say nothing here rather
            // than claim there was nothing to sync.
            (0, false) => String::new(),
            (0, true) => "No refs to sync.\n".to_string(),
            (synced, _) => format!("Synced {synced} refs, nothing changed.\n"),
        };
    }

    let mut table = vec![sync_row("ID", "REF", "FIELD", "CHANGE")];
    for change in &report.issue_changes {
        table.extend(issue_rows(change));
    }
    for change in &report.pull_request_changes {
        table.push(pull_request_row(change));
    }
    format!(
        "Synced {} refs, {changed} changed.\n\n{}",
        report.synced_count,
        crate::table::render_table(&table)
    )
}

fn issue_rows(change: &IssueSyncChange) -> Vec<Vec<String>> {
    let reference = format!("{}#{}", change.repo, change.number);
    let mut rows = Vec::new();
    if let Some(title) = &change.title {
        let previous = title.previous.as_deref().map(quoted);
        rows.push(sync_row(
            &change.task_id,
            &reference,
            "title",
            &render_transition(previous.as_deref(), &quoted(&title.current)),
        ));
    }
    if let Some(state) = &change.state {
        rows.push(sync_row(
            &change.task_id,
            &reference,
            "state",
            &render_transition(state.previous.map(|s| s.as_str()), state.current.as_str()),
        ));
    }
    rows
}

fn pull_request_row(change: &PullRequestSyncChange) -> Vec<String> {
    // A freshly linked PR has no prior status, so "linked (open)" says more than "- -> open".
    let rendered = match (&change.status, change.newly_linked) {
        (Some(status), true) => format!("linked ({})", status.current.as_str()),
        (Some(status), false) => {
            render_transition(status.previous.map(|s| s.as_str()), status.current.as_str())
        }
        (None, _) => "linked".to_string(),
    };
    sync_row(
        &change.task_id,
        &format!("{}#{}", change.repo, change.number),
        "pr",
        &rendered,
    )
}

fn sync_row(task_id: &str, reference: &str, field: &str, change: &str) -> Vec<String> {
    vec![
        task_id.to_string(),
        reference.to_string(),
        field.to_string(),
        change.to_string(),
    ]
}

fn render_transition(previous: Option<&str>, current: &str) -> String {
    format!("{} -> {current}", crate::table::or_dash(previous))
}

fn quoted(value: &str) -> String {
    format!("{value:?}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_application::{
        FieldChange, GithubPullRequestStatus, IssueSyncChange, PullRequestSyncChange,
    };

    fn issue_change(
        title: Option<FieldChange<String>>,
        state: Option<FieldChange<GithubIssueState>>,
    ) -> IssueSyncChange {
        IssueSyncChange {
            task_id: "MON-42".to_string(),
            repo: "ashigirl96/monica".to_string(),
            number: 481,
            title,
            state,
        }
    }

    #[test]
    fn render_sync_report_says_nothing_changed_without_hiding_the_work_done() {
        let report = GithubSyncReport {
            synced_count: 12,
            ..GithubSyncReport::default()
        };
        assert_eq!(
            render_sync_report(&report),
            "Synced 12 refs, nothing changed.\n"
        );
    }

    #[test]
    fn render_sync_report_distinguishes_having_nothing_to_sync() {
        assert_eq!(
            render_sync_report(&GithubSyncReport::default()),
            "No refs to sync.\n"
        );
    }

    #[test]
    fn render_sync_report_stays_silent_when_nothing_could_be_refreshed() {
        // Otherwise this prints "No refs to sync." for a sync that reached nothing — the exact
        // confusion that makes `monica task sync && monica task status` act on stale rows.
        let report = GithubSyncReport {
            unrefreshed: vec!["ashigirl96/monica#481".to_string()],
            ..GithubSyncReport::default()
        };
        assert_eq!(render_sync_report(&report), "");
    }

    #[test]
    fn incomplete_sync_message_names_what_stayed_stale() {
        // Mixed granularity on purpose: a whole repo went unreachable, one ref stopped resolving.
        assert_eq!(
            incomplete_sync_message(&["a/b".to_string(), "c/d#12".to_string()]),
            "sync incomplete: could not refresh a/b, c/d#12; those refs still show what was cached before"
        );
    }

    #[test]
    fn render_sync_report_lists_one_row_per_changed_field() {
        let report = GithubSyncReport {
            synced_count: 12,
            issue_changes: vec![issue_change(
                Some(FieldChange {
                    previous: Some("old title".to_string()),
                    current: "new title".to_string(),
                }),
                Some(FieldChange {
                    previous: Some(GithubIssueState::Open),
                    current: GithubIssueState::Closed,
                }),
            )],
            pull_request_changes: vec![
                PullRequestSyncChange {
                    task_id: "MON-39".to_string(),
                    repo: "ashigirl96/monica".to_string(),
                    number: 488,
                    status: Some(FieldChange {
                        previous: Some(GithubPullRequestStatus::Open),
                        current: GithubPullRequestStatus::Merged,
                    }),
                    newly_linked: false,
                },
                PullRequestSyncChange {
                    task_id: "MON-51".to_string(),
                    repo: "ashigirl96/monica".to_string(),
                    number: 490,
                    status: Some(FieldChange {
                        previous: None,
                        current: GithubPullRequestStatus::Open,
                    }),
                    newly_linked: true,
                },
            ],
            unrefreshed: Vec::new(),
        };

        assert_eq!(
            render_sync_report(&report),
            concat!(
                "Synced 12 refs, 4 changed.\n",
                "\n",
                "ID      REF                    FIELD  CHANGE\n",
                "MON-42  ashigirl96/monica#481  title  \"old title\" -> \"new title\"\n",
                "MON-42  ashigirl96/monica#481  state  open -> closed\n",
                "MON-39  ashigirl96/monica#488  pr     open -> merged\n",
                "MON-51  ashigirl96/monica#490  pr     linked (open)\n",
            )
        );
    }

    #[test]
    fn render_sync_report_marks_a_first_fetch_with_a_dash() {
        let report = GithubSyncReport {
            synced_count: 1,
            issue_changes: vec![issue_change(
                Some(FieldChange {
                    previous: None,
                    current: "first title".to_string(),
                }),
                Some(FieldChange {
                    previous: None,
                    current: GithubIssueState::Open,
                }),
            )],
            pull_request_changes: Vec::new(),
            unrefreshed: Vec::new(),
        };

        assert_eq!(
            render_sync_report(&report),
            concat!(
                "Synced 1 refs, 2 changed.\n",
                "\n",
                "ID      REF                    FIELD  CHANGE\n",
                "MON-42  ashigirl96/monica#481  title  - -> \"first title\"\n",
                "MON-42  ashigirl96/monica#481  state  - -> open\n",
            )
        );
    }

    use monica_application::GithubIssueState;
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

    #[test]
    fn render_status_table_formats_rows_and_empty_state() {
        let rows = vec![TaskSummaryRow {
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

        assert_eq!(render_status_table(&[]), "No tracked tasks found.\n");
    }
}
