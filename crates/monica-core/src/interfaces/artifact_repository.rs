use anyhow::Result;

use crate::domain::{
    Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind, Attachment, EssayListItem,
    IntentGroup, NewArtifact, NewDraft, TimelineCursor, TimelineItem,
};

pub trait ArtifactRepository {
    fn insert_draft(&mut self, new: NewDraft) -> Result<ArtifactDraft>;
    fn get_draft(&self, id: &str) -> Result<Option<ArtifactDraft>>;
    fn update_draft(
        &mut self,
        id: &str,
        kind: &ArtifactDraftKind,
        body: &str,
        occurred_at: Option<&str>,
        expected_revision: i64,
    ) -> Result<ArtifactDraft>;
    fn delete_draft(&mut self, id: &str) -> Result<()>;
    fn list_drafts(&self) -> Result<Vec<ArtifactDraft>>;

    fn promote_draft(&mut self, draft_id: &str, new: NewArtifact) -> Result<Artifact>;

    fn get_artifact(&self, id: &str) -> Result<Option<Artifact>>;
    fn update_artifact(
        &mut self,
        id: &str,
        kind: &ArtifactKind,
        body: &str,
        occurred_at: Option<&str>,
        expected_revision: i64,
    ) -> Result<Artifact>;
    fn convert_artifact_kind(
        &mut self,
        id: &str,
        target_kind: &ArtifactKind,
        expected_revision: i64,
    ) -> Result<Artifact>;
    fn delete_artifact(&mut self, id: &str) -> Result<()>;

    fn list_essays(&self) -> Result<Vec<EssayListItem>>;
    fn list_intents_by_project(&self) -> Result<Vec<IntentGroup>>;

    fn list_timeline_items(
        &self,
        before: Option<&TimelineCursor>,
        since: Option<&str>,
        limit: usize,
    ) -> Result<Vec<TimelineItem>>;

    fn insert_attachment(
        &mut self,
        entry_id: &str,
        original_file_name: &str,
        mime_type: Option<&str>,
        byte_size: i64,
        relative_path: &str,
    ) -> Result<Attachment>;
    fn update_attachment_path(&mut self, id: &str, relative_path: &str) -> Result<Attachment>;
    fn delete_attachment(&mut self, id: &str) -> Result<Option<String>>;
    fn list_attachments(&self, entry_id: &str) -> Result<Vec<Attachment>>;
}
