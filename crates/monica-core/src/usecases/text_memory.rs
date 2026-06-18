use anyhow::{anyhow, Result};

use crate::domain::{
    Artifact, ArtifactLinkKind, ArtifactListFilter, ArtifactSummary, ArtifactType,
    CreateArtifactInput, PersonalSpaceExport, UpdateArtifactInput,
};
use crate::interfaces::ArtifactRepository;

pub fn create_artifact(
    repo: &mut impl ArtifactRepository,
    input: CreateArtifactInput,
) -> Result<Artifact> {
    repo.insert_artifact(input.normalized()?)
}

pub fn update_artifact(
    repo: &mut impl ArtifactRepository,
    input: UpdateArtifactInput,
) -> Result<Artifact> {
    repo.update_artifact(input.normalized()?)
}

pub fn get_artifact(repo: &impl ArtifactRepository, id: &str) -> Result<Option<Artifact>> {
    repo.get_artifact(id)
}

pub fn list_artifacts(
    repo: &impl ArtifactRepository,
    filter: ArtifactListFilter,
) -> Result<Vec<ArtifactSummary>> {
    repo.list_artifacts(filter)
}

pub fn promote_record_to_intent_seed(
    repo: &mut impl ArtifactRepository,
    record_id: &str,
) -> Result<Artifact> {
    let record = repo
        .get_artifact(record_id)?
        .ok_or_else(|| anyhow!("artifact not found: {record_id}"))?;
    if record.artifact_type != ArtifactType::Record {
        return Err(anyhow!(
            "only Record artifacts can be promoted to Intent Seed"
        ));
    }

    let seed = repo.insert_artifact(
        CreateArtifactInput {
            artifact_type: ArtifactType::IntentSeed,
            title: record.title,
            body: record.body,
            status: None,
            source_artifact_id: Some(record.id.clone()),
        }
        .normalized()?,
    )?;
    repo.link_artifacts(&seed.id, &record.id, ArtifactLinkKind::DerivedFrom)?;
    Ok(seed)
}

pub fn personal_space_export(
    repo: &impl ArtifactRepository,
    exported_at_unix_ms: u64,
) -> Result<PersonalSpaceExport> {
    Ok(PersonalSpaceExport {
        exported_at_unix_ms,
        artifacts: repo.list_personal_artifacts()?,
        links: repo.list_artifact_links(None)?,
    })
}
