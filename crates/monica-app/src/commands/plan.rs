use std::path::PathBuf;

use serde::Serialize;

use monica_infra::Runtime;

#[derive(Serialize, specta::Type)]
pub struct PlanPreview {
    /// Absolute path of the plan file (`~/.claude/plans/<name>.md`).
    pub path: String,
    /// File name only, for the preview header.
    pub file_name: String,
    /// Markdown source of the plan.
    pub body: String,
}

/// Read the plan held by the run driving the given Workbench tab. `Ok(None)` covers a shell tab, a
/// run that never planned, and a plan file since deleted — all "nothing to preview" to the caller.
#[tauri::command]
#[specta::specta]
pub fn read_runspace_plan(terminal_tab_id: String) -> Result<Option<PlanPreview>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let Some(path) =
        monica_application::plan_path_for_terminal_tab(&runtime.repositories, &terminal_tab_id)
            .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let file_name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Ok(Some(PlanPreview { path, file_name, body }))
}
