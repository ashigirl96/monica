use anyhow::{bail, Result};

use crate::domain::{
    Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind, Attachment, EssayListItem,
    IntentGroup, NewArtifact, NewDraft, TimelineCursor, TimelineItem,
};
use crate::interfaces::ArtifactRepository;

pub fn quick_save_memo(repo: &mut impl ArtifactRepository, body: &str) -> Result<Artifact> {
    if body.trim().is_empty() {
        bail!("memo body must not be empty");
    }
    repo.insert_saved_memo(body)
}

pub fn create_draft(repo: &mut impl ArtifactRepository, new: NewDraft) -> Result<ArtifactDraft> {
    repo.insert_draft(new)
}

pub fn update_draft(
    repo: &mut impl ArtifactRepository,
    id: &str,
    kind: &ArtifactDraftKind,
    body: &str,
    occurred_at: Option<&str>,
    expected_revision: i64,
) -> Result<ArtifactDraft> {
    repo.update_draft(id, kind, body, occurred_at, expected_revision)
}

pub fn delete_draft(repo: &mut impl ArtifactRepository, id: &str) -> Result<()> {
    repo.delete_draft(id)
}

pub fn list_drafts(repo: &impl ArtifactRepository) -> Result<Vec<ArtifactDraft>> {
    repo.list_drafts()
}

pub fn save_draft(repo: &mut impl ArtifactRepository, draft_id: &str) -> Result<Artifact> {
    let draft = repo
        .get_draft(draft_id)?
        .ok_or_else(|| anyhow::anyhow!("draft {draft_id} not found"))?;

    let kind = validate_draft_kind(&draft.kind)?;
    if matches!(kind, ArtifactKind::Memo) && draft.body.trim().is_empty() {
        bail!("memo body must not be empty");
    }

    let new = NewArtifact {
        kind,
        body: draft.body,
        occurred_at: draft.occurred_at,
    };
    repo.promote_draft(draft_id, new)
}

fn validate_draft_kind(draft_kind: &ArtifactDraftKind) -> Result<ArtifactKind> {
    match draft_kind {
        ArtifactDraftKind::Memo => Ok(ArtifactKind::Memo),
        ArtifactDraftKind::Essay { title } => {
            let title = title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("essay requires a non-empty title"))?;
            Ok(ArtifactKind::Essay {
                title: title.to_string(),
            })
        }
        ArtifactDraftKind::Intent { title, project_id } => {
            let title = title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("intent requires a non-empty title"))?;
            Ok(ArtifactKind::Intent {
                title: title.to_string(),
                project_id: project_id.clone(),
            })
        }
    }
}

pub fn get_artifact(repo: &impl ArtifactRepository, id: &str) -> Result<Option<Artifact>> {
    repo.get_artifact(id)
}

pub fn update_artifact(
    repo: &mut impl ArtifactRepository,
    id: &str,
    kind: &ArtifactKind,
    body: &str,
    occurred_at: Option<&str>,
    expected_revision: i64,
) -> Result<Artifact> {
    repo.update_artifact(id, kind, body, occurred_at, expected_revision)
}

pub fn convert_artifact_kind(
    repo: &mut impl ArtifactRepository,
    id: &str,
    target_kind: &ArtifactKind,
    expected_revision: i64,
) -> Result<Artifact> {
    repo.convert_artifact_kind(id, target_kind, expected_revision)
}

pub fn delete_artifact(repo: &mut impl ArtifactRepository, id: &str) -> Result<()> {
    repo.delete_artifact(id)
}

pub fn list_essays(repo: &impl ArtifactRepository) -> Result<Vec<EssayListItem>> {
    repo.list_essays()
}

pub fn list_intents_by_project(repo: &impl ArtifactRepository) -> Result<Vec<IntentGroup>> {
    repo.list_intents_by_project()
}

pub fn list_timeline_items(
    repo: &impl ArtifactRepository,
    before: Option<&TimelineCursor>,
    since: Option<&str>,
    limit: usize,
) -> Result<Vec<TimelineItem>> {
    repo.list_timeline_items(before, since, limit)
}

pub fn insert_attachment(
    repo: &mut impl ArtifactRepository,
    entry_id: &str,
    original_file_name: &str,
    mime_type: Option<&str>,
    byte_size: i64,
    relative_path: &str,
) -> Result<Attachment> {
    repo.insert_attachment(entry_id, original_file_name, mime_type, byte_size, relative_path)
}

pub fn remove_attachment(repo: &mut impl ArtifactRepository, id: &str) -> Result<Option<String>> {
    repo.delete_attachment(id)
}

pub fn mime_from_extension(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "heic" => Some("image/heic"),
        _ => None,
    }
}

pub fn attach_image_from_path(
    repo: &mut impl ArtifactRepository,
    entry_id: &str,
    source: &std::path::Path,
    attachments_dir: &std::path::Path,
) -> Result<Attachment> {
    use std::fs;

    if !source.exists() {
        bail!("file not found: {}", source.display());
    }

    let original_file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();

    let Some(ext) = source
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
    else {
        bail!("unsupported image extension: {}", source.display());
    };
    let Some(mime_type) = mime_from_extension(ext) else {
        bail!("unsupported image extension: .{ext}");
    };

    let byte_size = fs::metadata(source)?.len() as i64;

    fs::create_dir_all(attachments_dir)?;

    let temp_att = repo.insert_attachment(
        entry_id,
        &original_file_name,
        Some(mime_type),
        byte_size,
        "pending",
    )?;

    let dest_name = format!("{}.{}", temp_att.id, ext);
    let relative_path = format!("{entry_id}/{dest_name}");
    let dest = attachments_dir.join(&dest_name);

    if let Err(e) = fs::copy(source, &dest) {
        let _ = repo.delete_attachment(&temp_att.id);
        bail!("failed to copy image: {e}");
    }

    repo.update_attachment_path(&temp_att.id, &relative_path)
}
