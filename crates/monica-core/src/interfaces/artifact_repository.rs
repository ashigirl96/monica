use anyhow::Result;

use crate::domain::{
    Artifact, ArtifactLink, ArtifactLinkKind, ArtifactListFilter, ArtifactSummary,
    CreateArtifactInput, UpdateArtifactInput,
};

pub trait ArtifactRepository {
    fn insert_artifact(&mut self, input: CreateArtifactInput) -> Result<Artifact>;
    fn update_artifact(&mut self, input: UpdateArtifactInput) -> Result<Artifact>;
    fn get_artifact(&self, id: &str) -> Result<Option<Artifact>>;
    fn list_artifacts(&self, filter: ArtifactListFilter) -> Result<Vec<ArtifactSummary>>;
    fn list_personal_artifacts(&self) -> Result<Vec<Artifact>>;
    fn link_artifacts(
        &mut self,
        from_artifact_id: &str,
        to_artifact_id: &str,
        kind: ArtifactLinkKind,
    ) -> Result<ArtifactLink>;
    fn list_artifact_links(&self, artifact_id: Option<&str>) -> Result<Vec<ArtifactLink>>;
}
