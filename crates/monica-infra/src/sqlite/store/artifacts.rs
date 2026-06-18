use anyhow::{anyhow, Result};
use monica_core::{
    Artifact, ArtifactLink, ArtifactLinkKind, ArtifactListFilter, ArtifactRepository,
    ArtifactSpace, ArtifactSummary, CreateArtifactInput, UpdateArtifactInput,
};
use rusqlite::params;

use crate::sqlite::SqliteStore;

use super::{ARTIFACT_COLUMNS, ARTIFACT_LINK_COLUMNS, SET_NOW};

impl ArtifactRepository for SqliteStore {
    fn insert_artifact(&mut self, input: CreateArtifactInput) -> Result<Artifact> {
        let input = input.normalized()?;
        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO artifact_counter DEFAULT VALUES", [])?;
        let id = format!("ART-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO artifacts
               (id, space, artifact_type, title, body, status, source_artifact_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                ArtifactSpace::Personal.as_str(),
                input.artifact_type.as_str(),
                input.title,
                input.body,
                input.status,
                input.source_artifact_id
            ],
        )?;

        let artifact = {
            let mut stmt =
                tx.prepare(&format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => crate::sqlite::row::artifact_from_row(row)?,
                None => return Err(anyhow!("inserted artifact {id} not found")),
            }
        };
        tx.commit()?;
        Ok(artifact)
    }

    fn update_artifact(&mut self, input: UpdateArtifactInput) -> Result<Artifact> {
        let input = input.normalized()?;
        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!(
                "UPDATE artifacts
                    SET artifact_type = ?1,
                        title = ?2,
                        body = ?3,
                        status = ?4,
                        updated_at = {SET_NOW}
                  WHERE id = ?5
                    AND deleted_at IS NULL"
            ),
            params![
                input.artifact_type.as_str(),
                input.title,
                input.body,
                input.status,
                input.id
            ],
        )?;
        if affected == 0 {
            return Err(anyhow!("artifact not found: {}", input.id));
        }

        let artifact = {
            let mut stmt =
                tx.prepare(&format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"))?;
            let mut rows = stmt.query(params![input.id])?;
            match rows.next()? {
                Some(row) => crate::sqlite::row::artifact_from_row(row)?,
                None => return Err(anyhow!("artifact not found after update")),
            }
        };
        tx.commit()?;
        Ok(artifact)
    }

    fn get_artifact(&self, id: &str) -> Result<Option<Artifact>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS}
               FROM artifacts
              WHERE id = ?1
                AND deleted_at IS NULL"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(crate::sqlite::row::artifact_from_row(row)?)),
            None => Ok(None),
        }
    }

    fn list_artifacts(&self, filter: ArtifactListFilter) -> Result<Vec<ArtifactSummary>> {
        let artifact_type = filter.artifact_type.map(|t| t.as_str().to_string());
        let query = filter
            .query
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let like = query.as_ref().map(|s| format!("%{}%", s.to_lowercase()));

        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS}
               FROM artifacts
              WHERE space = 'personal'
                AND deleted_at IS NULL
                AND (?1 IS NULL OR artifact_type = ?1)
                AND (
                  ?2 IS NULL
                  OR lower(coalesce(title, '') || char(10) || body) LIKE ?2
                )
              ORDER BY updated_at DESC, id DESC"
        ))?;
        let mut rows = stmt.query(params![artifact_type, like])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            let artifact = crate::sqlite::row::artifact_from_row(row)?;
            items.push(summary_from_artifact(&artifact, query.as_deref()));
        }
        Ok(items)
    }

    fn list_personal_artifacts(&self) -> Result<Vec<Artifact>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS}
               FROM artifacts
              WHERE space = 'personal'
                AND deleted_at IS NULL
              ORDER BY created_at, id"
        ))?;
        let mut rows = stmt.query([])?;
        let mut artifacts = Vec::new();
        while let Some(row) = rows.next()? {
            artifacts.push(crate::sqlite::row::artifact_from_row(row)?);
        }
        Ok(artifacts)
    }

    fn link_artifacts(
        &mut self,
        from_artifact_id: &str,
        to_artifact_id: &str,
        kind: ArtifactLinkKind,
    ) -> Result<ArtifactLink> {
        let tx = self.conn_mut().transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO artifact_links (from_artifact_id, to_artifact_id, kind)
             VALUES (?1, ?2, ?3)",
            params![from_artifact_id, to_artifact_id, kind.as_str()],
        )?;
        let link = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {ARTIFACT_LINK_COLUMNS}
                   FROM artifact_links
                  WHERE from_artifact_id = ?1
                    AND to_artifact_id = ?2
                    AND kind = ?3"
            ))?;
            let mut rows = stmt.query(params![from_artifact_id, to_artifact_id, kind.as_str()])?;
            match rows.next()? {
                Some(row) => crate::sqlite::row::artifact_link_from_row(row)?,
                None => {
                    return Err(anyhow!(
                        "artifact link not found after insert: {from_artifact_id} -> {to_artifact_id}"
                    ))
                }
            }
        };
        tx.commit()?;
        Ok(link)
    }

    fn list_artifact_links(&self, artifact_id: Option<&str>) -> Result<Vec<ArtifactLink>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ARTIFACT_LINK_COLUMNS}
               FROM artifact_links
              WHERE ?1 IS NULL
                 OR from_artifact_id = ?1
                 OR to_artifact_id = ?1
              ORDER BY created_at, id"
        ))?;
        let mut rows = stmt.query(params![artifact_id])?;
        let mut links = Vec::new();
        while let Some(row) = rows.next()? {
            links.push(crate::sqlite::row::artifact_link_from_row(row)?);
        }
        Ok(links)
    }
}

fn summary_from_artifact(artifact: &Artifact, query: Option<&str>) -> ArtifactSummary {
    ArtifactSummary {
        id: artifact.id.clone(),
        artifact_type: artifact.artifact_type,
        title: artifact.title.clone(),
        preview: preview(&artifact.body, query),
        status: artifact.status.clone(),
        source_artifact_id: artifact.source_artifact_id.clone(),
        created_at: artifact.created_at.clone(),
        updated_at: artifact.updated_at.clone(),
    }
}

fn preview(body: &str, query: Option<&str>) -> String {
    let compact = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if compact.is_empty() {
        return String::new();
    }

    let start = query
        .and_then(|q| {
            if q.trim().is_empty() {
                None
            } else {
                compact.find(q.trim()).map(|idx| idx.saturating_sub(40))
            }
        })
        .unwrap_or(0);
    let slice = compact.chars().skip(start).take(180).collect::<String>();
    if start > 0 {
        format!("...{slice}")
    } else {
        slice
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_core::{
        create_artifact, list_artifacts, promote_record_to_intent_seed, ArtifactType,
    };

    #[test]
    fn record_round_trips_without_title() {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let artifact = create_artifact(
            &mut db,
            CreateArtifactInput {
                artifact_type: ArtifactType::Record,
                title: None,
                body: "Rust cancellation note".to_string(),
                status: None,
                source_artifact_id: None,
            },
        )
        .unwrap();

        assert_eq!(artifact.id, "ART-1");
        assert_eq!(artifact.title, None);
        assert_eq!(
            db.get_artifact(&artifact.id).unwrap().unwrap().body,
            "Rust cancellation note"
        );
    }

    #[test]
    fn record_can_promote_to_intent_seed_with_source_link() {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let record = create_artifact(
            &mut db,
            CreateArtifactInput {
                artifact_type: ArtifactType::Record,
                title: None,
                body: "Build a capture-first memory layer".to_string(),
                status: None,
                source_artifact_id: None,
            },
        )
        .unwrap();

        let seed = promote_record_to_intent_seed(&mut db, &record.id).unwrap();

        assert_eq!(seed.artifact_type, ArtifactType::IntentSeed);
        assert_eq!(seed.status.as_deref(), Some("seed"));
        assert_eq!(seed.body, record.body);
        assert_eq!(seed.source_artifact_id.as_deref(), Some(record.id.as_str()));
        let links = db.list_artifact_links(Some(&seed.id)).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].to_artifact_id, record.id);
    }

    #[test]
    fn artifact_list_searches_title_and_body() {
        let mut db = SqliteStore::open_in_memory().unwrap();
        create_artifact(
            &mut db,
            CreateArtifactInput {
                artifact_type: ArtifactType::Record,
                title: None,
                body: "alpha beta".to_string(),
                status: None,
                source_artifact_id: None,
            },
        )
        .unwrap();
        create_artifact(
            &mut db,
            CreateArtifactInput {
                artifact_type: ArtifactType::IntentSeed,
                title: Some("Gamma plan".to_string()),
                body: String::new(),
                status: None,
                source_artifact_id: None,
            },
        )
        .unwrap();

        let body_hits = list_artifacts(
            &db,
            ArtifactListFilter {
                artifact_type: None,
                query: Some("beta".to_string()),
            },
        )
        .unwrap();
        assert_eq!(body_hits.len(), 1);
        assert_eq!(body_hits[0].id, "ART-1");

        let title_hits = list_artifacts(
            &db,
            ArtifactListFilter {
                artifact_type: Some(ArtifactType::IntentSeed),
                query: Some("gamma".to_string()),
            },
        )
        .unwrap();
        assert_eq!(title_hits.len(), 1);
        assert_eq!(title_hits[0].id, "ART-2");
    }
}
