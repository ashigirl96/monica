use super::ports::{TaskRunStore, TaskStore};
use crate::ports::TerminalSessionRepository;
use crate::prelude::{Agent, AgentSessionId, NewTaskRun, TaskId, TaskRunId, TaskStatus};
use crate::{ApplicationError, ApplicationResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachSessionReport {
    pub task_id: TaskId,
    pub task_title: String,
    pub task_run_id: TaskRunId,
    /// The agent session the tab's terminal session had already reported through hooks. `None`
    /// when no agent has reported in this tab yet; a later hook stamps it onto the run.
    pub agent_session_id: Option<AgentSessionId>,
    /// Runs this tab was driving before, now settled and unbound.
    pub detached_run_ids: Vec<TaskRunId>,
}

/// Connect the agent session living in a terminal tab to an existing task, as a run carrying no
/// worktree and no branch.
///
/// This is the only way a tab launched without `MONICA_TASK_ID` can ever reach a TaskRun: hook
/// resolution has no task to scope its lookups by, so it falls back to the tab -> run binding this
/// creates. The task's primary pointer is left alone — an attached session is a side run, so
/// `start_run` can still prepare a real worktree run for the same task.
///
/// `agent` must be the agent actually running in the tab. Nothing corrects it later — hook
/// observations never touch `agent` — and it is what a resume builds its command line from
/// (`agent_resume_command`), so a wrong value here would feed one agent's session id to another.
pub fn attach_terminal_session_to_task<R>(
    repos: &mut R,
    task_id: &TaskId,
    agent: Agent,
    terminal_tab_id: &str,
    terminal_session_id: &str,
) -> ApplicationResult<AttachSessionReport>
where
    R: TaskStore + TaskRunStore + TerminalSessionRepository,
{
    let task = repos
        .get_task(task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    if task.status == TaskStatus::Closed {
        return Err(ApplicationError::validation(format!(
            "task {task_id} is closed; reopen it before attaching a session"
        )));
    }

    let session = repos.get_terminal_session(terminal_session_id)?.ok_or_else(|| {
        ApplicationError::not_found(format!("terminal session not found: {terminal_session_id}"))
    })?;
    // Both ids come from the same tab's env; a mismatch means they were inherited from different
    // shells, and binding the wrong tab would send this task another tab's hooks.
    if session.tab_id.as_deref() != Some(terminal_tab_id) {
        return Err(ApplicationError::validation(format!(
            "terminal session {terminal_session_id} does not belong to tab {terminal_tab_id}"
        )));
    }

    let attachment = repos.attach_terminal_tab_to_task(
        NewTaskRun {
            task_id: task.id.clone(),
            agent: Some(agent),
            branch: None,
            worktree_path: None,
        },
        terminal_tab_id,
        session.agent_session_id.as_ref(),
    )?;

    Ok(AttachSessionReport {
        task_id: task.id,
        task_title: task.title,
        task_run_id: attachment.run.id,
        agent_session_id: attachment.run.agent_session_id,
        detached_run_ids: attachment.detached_run_ids,
    })
}
