use monica_core::{
    Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind, Attachment, EssayListItem,
    IntentGroup, TimelineCursor, TimelineItem,
};
use monica_infra::Runtime;

#[tauri::command]
#[specta::specta]
pub fn quick_save_memo(body: String) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::quick_save_memo(&mut runtime.repositories, &body)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_draft(kind: ArtifactDraftKind) -> Result<ArtifactDraft, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::create_draft(
        &mut runtime.repositories,
        monica_core::NewDraft {
            kind,
            body: String::new(),
            occurred_at: None,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_draft(
    id: String,
    kind: ArtifactDraftKind,
    body: String,
    occurred_at: Option<String>,
    expected_revision: i32,
) -> Result<ArtifactDraft, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::update_draft(
        &mut runtime.repositories,
        &id,
        &kind,
        &body,
        occurred_at.as_deref(),
        i64::from(expected_revision),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_draft(id: String) -> Result<(), String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::delete_draft(&mut runtime.repositories, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_drafts() -> Result<Vec<ArtifactDraft>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::list_drafts(&runtime.repositories).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn save_draft(id: String) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::save_draft(&mut runtime.repositories, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_artifact(id: String) -> Result<Option<Artifact>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::get_artifact(&runtime.repositories, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_artifact(
    id: String,
    kind: ArtifactKind,
    body: String,
    occurred_at: Option<String>,
    expected_revision: i32,
) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::update_artifact(
        &mut runtime.repositories,
        &id,
        &kind,
        &body,
        occurred_at.as_deref(),
        i64::from(expected_revision),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn convert_artifact_kind(
    id: String,
    target_kind: ArtifactKind,
    expected_revision: i32,
) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::convert_artifact_kind(
        &mut runtime.repositories,
        &id,
        &target_kind,
        i64::from(expected_revision),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_artifact(id: String) -> Result<(), String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::delete_artifact(&mut runtime.repositories, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_essays() -> Result<Vec<EssayListItem>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::list_essays(&runtime.repositories).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_intents_by_project() -> Result<Vec<IntentGroup>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::artifact_ops::list_intents_by_project(&runtime.repositories)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_timeline_items(
    before: Option<TimelineCursor>,
    since: Option<String>,
    limit: u32,
) -> Result<Vec<TimelineItem>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let mut items = monica_core::artifact_ops::list_timeline_items(
        &runtime.repositories,
        before.as_ref(),
        since.as_deref(),
        limit as usize,
    )
    .map_err(|e| e.to_string())?;

    if let Ok(base) = monica_infra::filesystem::paths::base_dir() {
        let att_base = base.join("attachments");
        for item in &mut items {
            if let TimelineItem::Artifact {
                thumbnail_paths, ..
            } = item
            {
                for path in thumbnail_paths.iter_mut() {
                    *path = att_base.join(&*path).to_string_lossy().into_owned();
                }
            }
        }
    }

    Ok(items)
}

#[tauri::command]
#[specta::specta]
pub fn attach_image(entry_id: String, file_path: String) -> Result<Attachment, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let source = std::path::Path::new(&file_path);
    let attachments_dir =
        monica_infra::filesystem::paths::attachments_dir(&entry_id).map_err(|e| e.to_string())?;
    monica_core::artifact_ops::attach_image_from_path(
        &mut runtime.repositories,
        &entry_id,
        source,
        &attachments_dir,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn remove_attachment(id: String) -> Result<(), String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    if let Some(relative_path) =
        monica_core::artifact_ops::remove_attachment(&mut runtime.repositories, &id)
            .map_err(|e| e.to_string())?
    {
        if let Ok(base) = monica_infra::filesystem::paths::base_dir() {
            let full_path = base.join("attachments").join(&relative_path);
            if full_path.exists() {
                if let Err(e) = std::fs::remove_file(&full_path) {
                    eprintln!("warn: failed to remove attachment file {}: {e}", full_path.display());
                }
            }
        }
    }
    Ok(())
}
