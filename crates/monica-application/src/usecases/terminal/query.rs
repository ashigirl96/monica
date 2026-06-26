use anyhow::Result;

use super::ports::TaskRunRepository;

/// The plan file path retained on the run currently driven by the given Workbench tab — set when
/// that run surfaced a plan via `ExitPlanMode`. `None` for a shell tab, a run that never planned,
/// or an unknown tab.
pub fn plan_path_for_terminal_tab<R>(repos: &R, terminal_tab_id: &str) -> Result<Option<String>>
where
    R: TaskRunRepository,
{
    Ok(repos
        .find_task_run_by_terminal_tab(terminal_tab_id)?
        .and_then(|run| run.plan_file_path))
}
