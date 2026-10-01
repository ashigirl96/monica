use std::collections::{HashMap, HashSet};

use super::ports::{TaskRunStore, TaskStore};
use crate::bench::bench_task_id;
use crate::ports::{TerminalSessionRepository, WorkbenchStore};
use crate::prelude::{
    CloseHold, RunspaceId, TaskId, TaskStatus, TerminalSession, TerminalSessionStatus,
};
use crate::ApplicationResult;

/// A runspace whose task is closed, so the Workbench terminates and drops it. `held_tab_id` is the
/// tab the close was issued from while its agent (or shell) is still alive: everything else goes,
/// that tab stays until a later poll finds the hold released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedRunspace {
    pub runspace_id: RunspaceId,
    pub held_tab_id: Option<String>,
}

/// What the Workbench tears down for closed tasks: the runspaces it shows, and the sessions spawned
/// in a closed task's bench that no tab shows any more (a tab closed before the task was, which
/// only detached its process).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClosedTaskCleanup {
    pub runspaces: Vec<ClosedRunspace>,
    pub detached_session_ids: Vec<String>,
}

/// The layout is frontend-owned and rewritten wholesale on every save, so the Workbench asks with
/// the runspaces it shows and applies the answer itself — a close from the CLI, the board, or while
/// the desktop was down all converge here.
pub fn closed_task_runspaces<R>(
    repos: &R,
    runspace_ids: &[RunspaceId],
) -> ApplicationResult<ClosedTaskCleanup>
where
    R: TaskStore + TaskRunStore + WorkbenchStore + TerminalSessionRepository,
{
    let holds = sweep_close_holds(repos)?;
    let mut closed_tasks = ClosedTasks::default();

    let mut runspaces = Vec::new();
    for runspace_id in runspace_ids {
        let Some(task_id) = bench_task_id(runspace_id) else { continue };
        if !closed_tasks.contains(repos, &task_id)? {
            continue;
        }
        runspaces.push(ClosedRunspace {
            runspace_id: runspace_id.clone(),
            held_tab_id: holds.get(&task_id).map(|hold| hold.terminal_tab_id.clone()),
        });
    }

    let held_sessions: HashSet<&str> =
        holds.values().map(|hold| hold.terminal_session_id.as_str()).collect();
    let mut detached_session_ids = Vec::new();
    for session in repos.list_terminal_sessions(None)? {
        if session.status != TerminalSessionStatus::Detached
            || held_sessions.contains(session.id.as_str())
        {
            continue;
        }
        let Some(task_id) = session_task(repos, &session)? else { continue };
        if closed_tasks.contains(repos, &task_id)? {
            detached_session_ids.push(session.id);
        }
    }

    Ok(ClosedTaskCleanup {
        runspaces,
        detached_session_ids,
    })
}

/// The task a session works for: the bench it was spawned in, or — for a shell spawned elsewhere and
/// attached later, whose `runspace_id` still names where it started — the run its tab stays bound
/// to after the close.
fn session_task<R: TaskRunStore>(
    repos: &R,
    session: &TerminalSession,
) -> ApplicationResult<Option<TaskId>> {
    if let Some(task_id) = session.runspace_id.as_ref().and_then(bench_task_id) {
        return Ok(Some(task_id));
    }
    let Some(tab_id) = session.tab_id.as_deref() else { return Ok(None) };
    Ok(repos.find_task_run_by_terminal_tab(tab_id)?.map(|run| run.task_id))
}

#[derive(Default)]
struct ClosedTasks(HashMap<TaskId, bool>);

impl ClosedTasks {
    fn contains<R: TaskStore>(&mut self, repos: &R, task_id: &TaskId) -> ApplicationResult<bool> {
        if let Some(&closed) = self.0.get(task_id) {
            return Ok(closed);
        }
        let closed = repos.get_task(task_id)?.is_some_and(|task| task.status == TaskStatus::Closed);
        self.0.insert(task_id.clone(), closed);
        Ok(closed)
    }
}

/// Drops every released hold and returns the live ones by task. Swept whole rather than per asked
/// runspace: a held tab whose shell exits is closed by the Workbench on the spot, so its runspace
/// is never asked about again.
fn sweep_close_holds<R>(repos: &R) -> ApplicationResult<HashMap<TaskId, CloseHold>>
where
    R: WorkbenchStore + TerminalSessionRepository,
{
    let mut live = HashMap::new();
    for hold in repos.list_close_holds()? {
        let session = repos.get_terminal_session(&hold.terminal_session_id)?;
        if hold.is_released(session.as_ref()) {
            repos.replace_close_hold(&hold.task_id, None)?;
        } else {
            live.insert(hold.task_id.clone(), hold);
        }
    }
    Ok(live)
}
