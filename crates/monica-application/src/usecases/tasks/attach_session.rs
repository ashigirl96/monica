use super::make_main::primary_mid_prepare;
use super::ports::{TaskRunStore, TaskStore};
use crate::ports::{TerminalSessionRepository, UnitOfWork, WorkbenchStore};
use crate::prelude::{
    Agent, AgentSessionId, NewTaskRun, RunspaceId, TaskId, TaskRunId, TaskStatus,
};
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
    /// The task's bench runspace the tab now belongs to.
    pub runspace_id: RunspaceId,
    /// The primary that stayed in place because it was mid-prepare. `None` means the attached run
    /// took the Main Run slot.
    pub kept_primary_run_id: Option<TaskRunId>,
}

impl AttachSessionReport {
    pub fn became_primary(&self) -> bool {
        self.kept_primary_run_id.is_none()
    }
}

/// A live run's tab and the bench runspace its task owns — where the Workbench must show the tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabTaskBinding {
    pub terminal_tab_id: String,
    pub task_id: TaskId,
    pub runspace_id: RunspaceId,
}

/// Connect the agent session living in a terminal tab to an existing task, as a run carrying no
/// worktree and no branch, and make that run the task's Main Run.
///
/// This is the only way a tab launched without `MONICA_TASK_ID` can ever reach a TaskRun: hook
/// resolution has no task to scope its lookups by, so it falls back to the tab -> run binding this
/// creates. The tab moves into the task's bench runspace, so the bench is created here when the
/// task has none yet — at `cwd`, the directory the tab's shell is in right now (its session only
/// remembers where it was spawned), never pinned, so a later worktree run still gets to pin it. An attached run is an in-place primary like a worktree-less Run: the only primary it
/// will not displace is one still mid-prepare, whose prepared worktree would otherwise be orphaned.
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
    cwd: &str,
) -> ApplicationResult<AttachSessionReport>
where
    R: TaskStore + TaskRunStore + TerminalSessionRepository + WorkbenchStore + UnitOfWork,
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
    // A dead session has no agent left to adopt; binding it would hand the task a `running`
    // Main Run that only the orphan sweep can ever settle.
    if session.status.is_terminal() {
        return Err(ApplicationError::validation(format!(
            "terminal session {terminal_session_id} is {}; attach needs a live shell",
            session.status.as_str()
        )));
    }
    // A shell spawned inside a bench carries MONICA_TASK_ID, so its hooks resolve through the
    // task-scoped rules and would never reach a run attached here — the CLI refuses such tabs by
    // env; this is the same refusal for callers that only know the session.
    if let Some(bound_task) = bench_owner(repos, session.runspace_id.as_ref())? {
        return Err(ApplicationError::validation(format!(
            "this tab is already bound to task {bound_task}; attach is for tabs started outside a task"
        )));
    }

    // The run, the primary pointer, and the bench land as one transaction, as in `start_run`: a
    // crash between them would strand a run with no runspace for the Workbench to move its tab to.
    // The primary is re-read inside it: a Prepare committing between a snapshot taken outside and
    // the pointer update below would have its fresh worktree run silently displaced.
    let mut tx = repos.begin()?;
    let task = tx
        .get_task(task_id)?
        .ok_or_else(|| ApplicationError::not_found(format!("task not found: {task_id}")))?;
    let kept_primary_run_id = primary_mid_prepare(&*tx, &task)?;
    let attachment = tx.attach_terminal_tab_to_task(
        NewTaskRun {
            task_id: task.id.clone(),
            agent: Some(agent),
            branch: None,
            worktree_path: None,
        },
        terminal_tab_id,
        session.agent_session_id.as_ref(),
    )?;
    if kept_primary_run_id.is_none() {
        tx.set_primary_task_run(&task.id, &attachment.run.id)?;
    }
    let (runspace_id, _, _) =
        crate::usecases::runs::open_bench::ensure_bench(&mut *tx, &task.id, cwd, false)?;
    tx.commit()?;

    Ok(AttachSessionReport {
        task_id: task.id,
        task_title: task.title,
        task_run_id: attachment.run.id,
        agent_session_id: attachment.run.agent_session_id,
        detached_run_ids: attachment.detached_run_ids,
        runspace_id,
        kept_primary_run_id,
    })
}

fn bench_owner<R>(repos: &R, runspace_id: Option<&RunspaceId>) -> ApplicationResult<Option<TaskId>>
where
    R: WorkbenchStore,
{
    let Some(runspace_id) = runspace_id else {
        return Ok(None);
    };
    Ok(repos
        .list_bench_runspace_map()?
        .into_iter()
        .find(|(bench, _)| bench == runspace_id)
        .map(|(_, task_id)| task_id))
}

/// Every live run driven from a terminal tab, paired with its task's bench runspace. The Workbench
/// polls this to pull tabs into the runspace they belong to — the layout is frontend-owned, so a
/// binding made by the CLI (a separate process) can only reach the screen this way. Runs whose task
/// has no bench are skipped: there is nowhere to move the tab.
pub fn list_tab_task_bindings<R>(repos: &R) -> ApplicationResult<Vec<TabTaskBinding>>
where
    R: TaskRunStore + WorkbenchStore,
{
    let mut bindings = Vec::new();
    for run in repos.list_driven_task_runs_with_tab()? {
        let Some(terminal_tab_id) = run.terminal_tab_id else {
            continue;
        };
        if let Some((runspace_id, _)) = repos.get_bench_for_task(&run.task_id)? {
            bindings.push(TabTaskBinding {
                terminal_tab_id,
                task_id: run.task_id,
                runspace_id,
            });
        }
    }
    Ok(bindings)
}
