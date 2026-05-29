use monica_core::{Db, Event, IssueStatusRow, WorkItem};

#[tauri::command]
fn list_work_items() -> Result<Vec<WorkItem>, String> {
    let db = Db::open().map_err(|e| e.to_string())?;
    db.list_work_items().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_issue_statuses() -> Result<Vec<IssueStatusRow>, String> {
    let db = Db::open().map_err(|e| e.to_string())?;
    db.list_issue_statuses(None, None).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_events(work_item_id: String) -> Result<Vec<Event>, String> {
    let db = Db::open().map_err(|e| e.to_string())?;
    db.list_events(Some(&work_item_id)).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_work_items,
            list_issue_statuses,
            list_events
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
