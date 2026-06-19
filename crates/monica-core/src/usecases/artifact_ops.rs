use anyhow::{bail, Result};

use crate::domain::{
    Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind, Attachment, EssayListItem,
    IntentGroup, NewArtifact, NewDraft, TimelineCursor, TimelineItem,
};
use crate::interfaces::ArtifactRepository;

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
