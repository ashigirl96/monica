use std::collections::HashMap;

use super::ports::TaskStore;
use crate::bench::bench_task_id;
use crate::ports::{TerminalSessionRepository, WorkbenchStore};
use crate::prelude::{RunspaceId, TaskId, TaskStatus};
use crate::ApplicationResult;

/// A runspace whose task is closed, so the Workbench terminates and drops it. `held_tab_id` is the
/// tab the close was issued from while its agent (or shell) is still alive: everything else goes,
/// that tab stays until a later poll finds the hold released.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedRunspace {
    pub runspace_id: RunspaceId,
    pub held_tab_id: Option<String>,
}

/// Which of `runspace_ids` belong to a closed task. The layout is frontend-owned and rewritten
/// wholesale on every save, so the Workbench asks with what it shows and applies the answer itself
/// — a close from the CLI, the board, or while the desktop was down all converge here.
pub fn closed_task_runspaces<R>(
    repos: &R,
    runspace_ids: &[RunspaceId],
) -> ApplicationResult<Vec<ClosedRunspace>>
where
    R: TaskStore + WorkbenchStore + TerminalSessionRepository,
{
    let held_tabs = sweep_close_holds(repos)?;
    let mut closed = Vec::new();
    for runspace_id in runspace_ids {
        let Some(task_id) = bench_task_id(runspace_id) else { continue };
        let Some(task) = repos.get_task(&task_id)? else { continue };
        if task.status != TaskStatus::Closed {
            continue;
        }
        closed.push(ClosedRunspace {
            runspace_id: runspace_id.clone(),
            held_tab_id: held_tabs.get(&task_id).cloned(),
        });
    }
    Ok(closed)
}

/// Drops every released hold and returns the tab each live one spares. Swept whole rather than per
/// asked runspace: a held tab whose shell exits is closed by the Workbench on the spot, so its
/// runspace is never asked about again.
fn sweep_close_holds<R>(repos: &R) -> ApplicationResult<HashMap<TaskId, String>>
where
    R: WorkbenchStore + TerminalSessionRepository,
{
    let mut held_tabs = HashMap::new();
    for hold in repos.list_close_holds()? {
        let session = repos.get_terminal_session(&hold.terminal_session_id)?;
        if hold.is_released(session.as_ref()) {
            repos.replace_close_hold(&hold.task_id, None)?;
        } else {
            held_tabs.insert(hold.task_id, hold.terminal_tab_id);
        }
    }
    Ok(held_tabs)
}
