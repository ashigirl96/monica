use std::path::PathBuf;

use monica_api::ApiError;
use serde::Serialize;
use tauri::AppHandle;

use crate::event_sink;

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
pub fn read_runspace_plan(
    app: AppHandle,
    terminal_tab_id: String,
) -> Result<Option<PlanPreview>, ApiError> {
    let mut monica = event_sink::open(&app)?;
    let Some(path) = monica.tasks().plan_path_for_terminal_tab(&terminal_tab_id)? else {
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
