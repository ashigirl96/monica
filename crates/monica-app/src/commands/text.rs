use std::time::{SystemTime, UNIX_EPOCH};

use monica_core::{
    intent_seed_status_options, personal_space_export, promote_record_to_intent_seed,
    text_artifact_type_options, update_artifact, Artifact, ArtifactListFilter, ArtifactSummary,
    ArtifactType, ArtifactTypeOption, CreateArtifactInput, IntentSeedStatusOption,
    UpdateArtifactInput,
};
use monica_infra::{filesystem::paths, Runtime};
use serde::Serialize;

#[derive(Serialize, specta::Type)]
pub struct TextExportResult {
    pub path: String,
    #[specta(type = specta_typescript::Number)]
    pub artifact_count: usize,
    #[specta(type = specta_typescript::Number)]
    pub link_count: usize,
}

#[tauri::command]
#[specta::specta]
pub fn list_text_artifacts(
    artifact_type: Option<ArtifactType>,
    query: Option<String>,
) -> Result<Vec<ArtifactSummary>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::list_artifacts(
        &runtime.repositories,
        ArtifactListFilter {
            artifact_type,
            query,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_text_artifact(id: String) -> Result<Option<Artifact>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::get_artifact(&runtime.repositories, &id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_text_artifact(input: CreateArtifactInput) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    monica_core::create_artifact(&mut runtime.repositories, input).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn update_text_artifact(input: UpdateArtifactInput) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    update_artifact(&mut runtime.repositories, input).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn promote_text_record_to_intent_seed(record_id: String) -> Result<Artifact, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    promote_record_to_intent_seed(&mut runtime.repositories, &record_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn text_artifact_type_options_command() -> Vec<ArtifactTypeOption> {
    text_artifact_type_options()
}

#[tauri::command]
#[specta::specta]
pub fn intent_seed_status_options_command() -> Vec<IntentSeedStatusOption> {
    intent_seed_status_options()
}

#[tauri::command]
#[specta::specta]
pub fn export_personal_space() -> Result<TextExportResult, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let exported_at_unix_ms = unix_ms_now()?;
    let export = personal_space_export(&runtime.repositories, exported_at_unix_ms)
        .map_err(|e| e.to_string())?;
    let dir = paths::exports_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("personal-space-{exported_at_unix_ms}.json"));
    let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(TextExportResult {
        path: path.to_string_lossy().into_owned(),
        artifact_count: export.artifacts.len(),
        link_count: export.links.len(),
    })
}

fn unix_ms_now() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(duration.as_millis() as u64)
}
