use std::io::ErrorKind;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use monica_application::ExplanationRepository;
use monica_domain::{Explanation, ExplanationMode, NewExplanation};
use rusqlite::{params, Row};

use crate::SqliteStore;

const EXPLANATION_COLUMNS: &str = "id, title, mode, artifact_path, provider_session_id, terminal_session_id, created_at";

fn explanation_from_row(row: &Row<'_>) -> Result<Explanation> {
    let mode: String = row.get("mode")?;
    Ok(Explanation {
        id: row.get("id")?,
        title: row.get("title")?,
        mode: mode.parse::<ExplanationMode>()?,
        artifact_path: row.get("artifact_path")?,
        provider_session_id: row.get("provider_session_id")?,
        terminal_session_id: row.get("terminal_session_id")?,
        created_at: row.get("created_at")?,
    })
}

impl SqliteStore {
    pub fn create_explanation(
        &mut self,
        new: NewExplanation,
        artifact_root: &Path,
    ) -> Result<Explanation> {
        path_as_utf8(artifact_root)?;
        std::fs::create_dir_all(artifact_root).with_context(|| {
            format!("failed to create explanation root {}", artifact_root.display())
        })?;

        let tx = self.conn_mut().transaction()?;
        let (id, artifact_dir) = loop {
            tx.execute("INSERT INTO explanation_counter DEFAULT VALUES", [])?;
            let id = format!("exp-{}", tx.last_insert_rowid());
            let artifact_dir = artifact_root.join(&id);
            match std::fs::create_dir(&artifact_dir) {
                Ok(()) => break (id, artifact_dir),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "failed to create explanation directory {}",
                            artifact_dir.display()
                        )
                    });
                }
            }
        };
        let artifact_path = path_as_utf8(&artifact_dir)?;

        let persist = (|| -> Result<()> {
            tx.execute(
                "INSERT INTO explanations
                   (id, title, mode, artifact_path, provider_session_id, terminal_session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    id,
                    new.title,
                    new.mode.as_str(),
                    artifact_path,
                    new.provider_session_id,
                    new.terminal_session_id,
                ],
            )?;
            tx.commit()?;
            Ok(())
        })();

        if let Err(error) = persist {
            std::fs::remove_dir(&artifact_dir).ok();
            return Err(error);
        }

        self.get_explanation(&id)?
            .ok_or_else(|| anyhow!("explanation {id} vanished after insert"))
    }

    pub fn list_explanations(&self) -> Result<Vec<Explanation>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {EXPLANATION_COLUMNS} FROM explanations
             ORDER BY created_at DESC, CAST(SUBSTR(id, 5) AS INTEGER) DESC"
        ))?;
        let rows = stmt
            .query_map([], |row| {
                explanation_from_row(row).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        error.into(),
                    )
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_explanation(&self, id: &str) -> Result<Option<Explanation>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {EXPLANATION_COLUMNS} FROM explanations WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(explanation_from_row(row)?)),
            None => Ok(None),
        }
    }
}

impl ExplanationRepository for SqliteStore {
    fn create_explanation(
        &mut self,
        new: NewExplanation,
        artifact_root: &Path,
    ) -> Result<Explanation> {
        SqliteStore::create_explanation(self, new, artifact_root)
    }

    fn list_explanations(&self) -> Result<Vec<Explanation>> {
        SqliteStore::list_explanations(self)
    }

    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>> {
        SqliteStore::get_explanation(self, id)
    }
}

fn path_as_utf8(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("explanation path is not valid UTF-8: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn artifact_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "monica-explanations-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&path).ok();
        path
    }

    fn new(title: &str) -> NewExplanation {
        NewExplanation {
            title: title.to_string(),
            mode: ExplanationMode::Topic,
            provider_session_id: "provider-1".to_string(),
            terminal_session_id: "ts-1".to_string(),
        }
    }

    #[test]
    fn creates_directory_and_round_trips_explanation() {
        let root = artifact_root("round-trip");
        let mut db = SqliteStore::open_in_memory().unwrap();

        let created = db.create_explanation(new("How sessions work"), &root).unwrap();

        assert_eq!(created.id, "exp-1");
        assert_eq!(created.mode, ExplanationMode::Topic);
        assert!(Path::new(&created.artifact_path).is_dir());
        assert_eq!(db.get_explanation("exp-1").unwrap(), Some(created.clone()));
        assert_eq!(db.list_explanations().unwrap(), vec![created]);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn skips_stale_artifact_directory_without_overwriting_it() {
        let root = artifact_root("stale");
        std::fs::create_dir_all(root.join("exp-1")).unwrap();
        std::fs::write(root.join("exp-1/index.html"), "old").unwrap();
        let mut db = SqliteStore::open_in_memory().unwrap();

        let created = db.create_explanation(new("Fresh"), &root).unwrap();

        assert_eq!(created.id, "exp-2");
        assert_eq!(std::fs::read_to_string(root.join("exp-1/index.html")).unwrap(), "old");
        assert!(root.join("exp-2").is_dir());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lists_newest_first_with_id_as_a_stable_tiebreaker() {
        let root = artifact_root("order");
        let mut db = SqliteStore::open_in_memory().unwrap();
        db.create_explanation(new("First"), &root).unwrap();
        db.create_explanation(new("Second"), &root).unwrap();
        db.conn()
            .execute("UPDATE explanations SET created_at = '2026-07-11T00:00:00.000Z'", [])
            .unwrap();

        let ids: Vec<String> = db
            .list_explanations()
            .unwrap()
            .into_iter()
            .map(|explanation| explanation.id)
            .collect();

        assert_eq!(ids, ["exp-2", "exp-1"]);
        std::fs::remove_dir_all(root).ok();
    }
}
