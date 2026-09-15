use serde::Serialize;

use super::make_main::primary_run;
use super::ports::{TaskRunStore, TaskStore};
use super::tab_identity::TabIdentity;
use crate::ports::{TaskBoardQuery, TerminalSessionRepository};
use crate::prelude::{DisplayStatus, TaskId, TaskRun, TaskRunStatus, TaskStatus};
use crate::{ApplicationError, ApplicationResult};

/// How the tab's task was found, which is also how much to trust it: `Env` is the task the shell
/// was launched under, `Tab` the binding `monica task attach` wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CurrentTaskSource {
    Env,
    Tab,
}

impl CurrentTaskSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CurrentTaskSource::Env => "env",
            CurrentTaskSource::Tab => "tab",
        }
    }
}

/// The task a terminal tab is working on, flattened into the fields a script reads.
///
/// `status` is the board projection (primary-run based, what the Work Board shows for this task)
/// while `task_run_id` / `task_run_status` describe the run this very tab drives. They disagree
/// whenever the tab's run is not the Main Run — an attach that left a mid-prepare primary in
/// place, or another tab taking Main since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CurrentTaskReport {
    pub task_id: String,
    pub title: String,
    pub project: Option<String>,
    pub github_issue_number: Option<i64>,
    pub github_issue_url: Option<String>,
    pub task_status: TaskStatus,
    pub status: DisplayStatus,
    pub task_run_id: Option<String>,
    pub task_run_status: Option<TaskRunStatus>,
    pub source: CurrentTaskSource,
}

/// The task bound to the terminal tab described by `identity`.
///
/// A tab launched from a task carries `MONICA_TASK_ID` and is answered from it. Every other tab —
/// including one a `monica task attach` later bound, which can never gain the variable because its
/// shell is already running — resolves through the tab -> run binding in `task_runs`, the same
/// lookup hook resolution falls back to for a task-less tab.
pub fn resolve_current_task<R>(
    repos: &R,
    identity: &TabIdentity,
) -> ApplicationResult<CurrentTaskReport>
where
    R: TaskStore + TaskRunStore + TerminalSessionRepository + TaskBoardQuery,
{
    let tab_id = resolve_tab_id(repos, identity)?;
    let tab_run = match tab_id.as_deref() {
        Some(tab_id) => repos.find_task_run_by_terminal_tab(tab_id)?,
        None => None,
    };

    let (task_id, run, source) = match identity.task_id.as_deref() {
        Some(task_id) => {
            let task_id = TaskId::from_store(task_id.to_string());
            // The tab's run answers for this task only when it is actually this task's run; an env
            // inherited across tabs would otherwise report another task's run as ours.
            let run = match tab_run.filter(|run| run.task_id == task_id) {
                Some(run) => Some(run),
                None => primary_run(repos, &task_id)?,
            };
            (task_id, run, CurrentTaskSource::Env)
        }
        None => {
            if !identity.is_monica_tab() {
                return Err(TabIdentity::no_tab());
            }
            let run = tab_run.ok_or_else(|| {
                ApplicationError::not_found("no task is bound to this tab")
            })?;
            (run.task_id.clone(), Some(run), CurrentTaskSource::Tab)
        }
    };

    report(repos, &task_id, run.as_ref(), source)
}

/// The tab the identity names: its own id, or the tab owning the session it names. A session
/// without a tab (a daemon-only shell) leaves this `None`.
fn resolve_tab_id<R>(repos: &R, identity: &TabIdentity) -> ApplicationResult<Option<String>>
where
    R: TerminalSessionRepository,
{
    if let Some(tab_id) = identity.terminal_tab_id.as_deref() {
        return Ok(Some(tab_id.to_string()));
    }
    let Some(session_id) = identity.terminal_session_id.as_deref() else {
        return Ok(None);
    };
    Ok(repos.get_terminal_session(session_id)?.and_then(|session| session.tab_id))
}

fn report<R>(
    repos: &R,
    task_id: &TaskId,
    run: Option<&TaskRun>,
    source: CurrentTaskSource,
) -> ApplicationResult<CurrentTaskReport>
where
    R: TaskBoardQuery,
{
    let summary = crate::usecases::query::find_task_summary(repos, task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    Ok(CurrentTaskReport {
        task_id: summary.id,
        title: summary.title,
        project: summary.project,
        github_issue_number: summary.github_issue_number,
        github_issue_url: summary.github_issue_url,
        task_status: summary.task_status,
        status: summary.status,
        task_run_id: run.map(|run| run.id.to_string()),
        task_run_status: run.map(|run| run.status),
        source,
    })
}
