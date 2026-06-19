use monica_core::{
    Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind, Attachment, EssayListItem,
    IntentGroup, TimelineCursor, TimelineItem,
};
use monica_infra::Runtime;

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
    monica_core::artifact_ops::list_timeline_items(
        &runtime.repositories,
        before.as_ref(),
        since.as_deref(),
        limit as usize,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn attach_image(entry_id: String, file_path: String) -> Result<Attachment, String> {
    let source = std::path::Path::new(&file_path);
    if !source.exists() {
        return Err(format!("file not found: {file_path}"));
    }

    let original_file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "unsupported image extension: <none>".to_string())?;

    let byte_size = std::fs::metadata(source)
        .map_err(|e| e.to_string())?
        .len() as i64;

    let mime_type =
        image_mime_type(ext).ok_or_else(|| format!("unsupported image extension: .{ext}"))?;

    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;

    let attachments_dir =
        monica_infra::filesystem::paths::attachments_dir(&entry_id).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let temp_att = monica_core::artifact_ops::insert_attachment(
        &mut runtime.repositories,
        &entry_id,
        &original_file_name,
        Some(mime_type),
        byte_size,
        "pending",
    )
    .map_err(|e| e.to_string())?;

    let dest_name = format!("{}.{}", temp_att.id, ext);
    let relative_path = format!("{entry_id}/{dest_name}");
    let dest = attachments_dir.join(&dest_name);

    if let Err(e) = std::fs::copy(source, &dest) {
        let _ = monica_core::artifact_ops::remove_attachment(
            &mut runtime.repositories,
            &temp_att.id,
        );
        return Err(format!("failed to copy image: {e}"));
    }

    let _ = monica_core::artifact_ops::remove_attachment(
        &mut runtime.repositories,
        &temp_att.id,
    );
    monica_core::artifact_ops::insert_attachment(
        &mut runtime.repositories,
        &entry_id,
        &original_file_name,
        Some(mime_type),
        byte_size,
        &relative_path,
    )
    .map_err(|e| e.to_string())
}

fn image_mime_type(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "heic" => Some("image/heic"),
        _ => None,
    }
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
