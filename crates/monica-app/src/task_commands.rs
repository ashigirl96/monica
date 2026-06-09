use monica_core::{BoardColumn, TaskSummaryRow};
use monica_infra::Runtime;

#[tauri::command]
#[specta::specta]
pub fn list_task_summaries() -> Result<Vec<TaskSummaryRow>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_task_summaries(&runtime.repositories, None, None).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_board_columns() -> Vec<BoardColumn> {
    monica_core::board_columns()
}
