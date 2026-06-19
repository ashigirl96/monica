use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::params;

use crate::sqlite::SqliteStore;
use monica_core::{
    Artifact, ArtifactDraft, ArtifactDraftKind, ArtifactKind, ArtifactRepository, Attachment,
    EssayListItem, IntentGroup, IntentListItem, NewArtifact, NewDraft, TimelineCursor, TimelineItem,
};

use super::SET_NOW;

const ENTRY_COLUMNS: &str =
    "id, state, kind, title, body_markdown, project_id, occurred_at, revision, created_at, updated_at";

impl ArtifactRepository for SqliteStore {
    fn insert_draft(&mut self, new: NewDraft) -> Result<ArtifactDraft> {
        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO artifact_counter DEFAULT VALUES", [])?;
        let id = format!("ART-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO library_entries (id, state, kind, title, body_markdown, project_id, occurred_at)
             VALUES (?1, 'draft', ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                new.kind.kind_str(),
                new.kind.title(),
                new.body,
                new.kind.project_id(),
                new.occurred_at,
            ],
        )?;
        let draft = {
            let mut stmt =
                tx.prepare(&format!("SELECT {ENTRY_COLUMNS} FROM library_entries WHERE id = ?1"))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => draft_from_row(row)?,
                None => return Err(anyhow!("inserted draft {id} not found")),
            }
        };
        tx.commit()?;
        Ok(draft)
    }

    fn get_draft(&self, id: &str) -> Result<Option<ArtifactDraft>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ENTRY_COLUMNS} FROM library_entries WHERE id = ?1 AND state = 'draft'"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => {
                let mut draft = draft_from_row(row)?;
                draft.attachments = self.list_attachments(id)?;
                Ok(Some(draft))
            }
            None => Ok(None),
        }
    }

    fn update_draft(
        &mut self,
        id: &str,
        kind: &ArtifactDraftKind,
        body: &str,
        occurred_at: Option<&str>,
        expected_revision: i64,
    ) -> Result<ArtifactDraft> {
        let updated = self.conn().execute(
            &format!(
                "UPDATE library_entries
                 SET kind = ?1, title = ?2, body_markdown = ?3, project_id = ?4,
                     occurred_at = ?5, revision = revision + 1, updated_at = {SET_NOW}
                 WHERE id = ?6 AND state = 'draft' AND revision = ?7"
            ),
            params![
                kind.kind_str(),
                kind.title(),
                body,
                kind.project_id(),
                occurred_at,
                id,
                expected_revision,
            ],
        )?;
        if updated == 0 {
            bail!("stale write: draft {id} revision mismatch or not found");
        }
        self.get_draft(id)?
            .ok_or_else(|| anyhow!("draft {id} not found after update"))
    }

    fn delete_draft(&mut self, id: &str) -> Result<()> {
        delete_entry_with_attachments(self, id, "draft")
    }

    fn list_drafts(&self) -> Result<Vec<ArtifactDraft>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ENTRY_COLUMNS} FROM library_entries WHERE state = 'draft' ORDER BY updated_at DESC"
        ))?;
        let mut rows = stmt.query([])?;
        let mut drafts = Vec::new();
        while let Some(row) = rows.next()? {
            drafts.push(draft_from_row(row)?);
        }
        drop(rows);
        drop(stmt);
        for draft in &mut drafts {
            draft.attachments = self.list_attachments(&draft.id)?;
        }
        Ok(drafts)
    }

    fn promote_draft(&mut self, draft_id: &str, new: NewArtifact) -> Result<Artifact> {
        let updated = self.conn().execute(
            &format!(
                "UPDATE library_entries
                 SET state = 'saved', kind = ?1, title = ?2, body_markdown = ?3,
                     project_id = ?4, occurred_at = ?5, revision = revision + 1,
                     updated_at = {SET_NOW}
                 WHERE id = ?6 AND state = 'draft'"
            ),
            params![
                new.kind.kind_str(),
                new.kind.title(),
                new.body,
                new.kind.project_id(),
                new.occurred_at,
                draft_id,
            ],
        )?;
        if updated == 0 {
            bail!("draft {draft_id} not found or already saved");
        }
        self.get_artifact(draft_id)?
            .ok_or_else(|| anyhow!("artifact {draft_id} not found after promote"))
    }

    fn get_artifact(&self, id: &str) -> Result<Option<Artifact>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {ENTRY_COLUMNS} FROM library_entries WHERE id = ?1 AND state = 'saved'"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => {
                let mut artifact = artifact_from_row(row)?;
                artifact.attachments = self.list_attachments(id)?;
                Ok(Some(artifact))
            }
            None => Ok(None),
        }
    }

    fn update_artifact(
        &mut self,
        id: &str,
        kind: &ArtifactKind,
        body: &str,
        occurred_at: Option<&str>,
        expected_revision: i64,
    ) -> Result<Artifact> {
        let updated = self.conn().execute(
            &format!(
                "UPDATE library_entries
                 SET kind = ?1, title = ?2, body_markdown = ?3, project_id = ?4,
                     occurred_at = ?5, revision = revision + 1, updated_at = {SET_NOW}
                 WHERE id = ?6 AND state = 'saved' AND revision = ?7"
            ),
            params![
                kind.kind_str(),
                kind.title(),
                body,
                kind.project_id(),
                occurred_at,
                id,
                expected_revision,
            ],
        )?;
        if updated == 0 {
            bail!("stale write: artifact {id} revision mismatch or not found");
        }
        self.get_artifact(id)?
            .ok_or_else(|| anyhow!("artifact {id} not found after update"))
    }

    fn convert_artifact_kind(
        &mut self,
        id: &str,
        target_kind: &ArtifactKind,
        expected_revision: i64,
    ) -> Result<Artifact> {
        let updated = self.conn().execute(
            &format!(
                "UPDATE library_entries
                 SET kind = ?1, title = ?2, project_id = ?3,
                     revision = revision + 1, updated_at = {SET_NOW}
                 WHERE id = ?4 AND state = 'saved' AND revision = ?5"
            ),
            params![
                target_kind.kind_str(),
                target_kind.title(),
                target_kind.project_id(),
                id,
                expected_revision,
            ],
        )?;
        if updated == 0 {
            bail!("stale write: artifact {id} revision mismatch or not found");
        }
        self.get_artifact(id)?
            .ok_or_else(|| anyhow!("artifact {id} not found after kind conversion"))
    }

    fn delete_artifact(&mut self, id: &str) -> Result<()> {
        delete_entry_with_attachments(self, id, "saved")
    }

    fn list_essays(&self) -> Result<Vec<EssayListItem>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, title, substr(body_markdown, 1, 200) AS body_preview, updated_at
             FROM library_entries
             WHERE state = 'saved' AND kind = 'essay'
             ORDER BY updated_at DESC",
        )?;
        let mut rows = stmt.query([])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(EssayListItem {
                id: row.get("id")?,
                title: row.get::<_, String>("title")?,
                body_preview: row.get("body_preview")?,
                updated_at: row.get("updated_at")?,
            });
        }
        Ok(items)
    }

    fn list_intents_by_project(&self) -> Result<Vec<IntentGroup>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, title, substr(body_markdown, 1, 200) AS body_preview, project_id
             FROM library_entries
             WHERE state = 'saved' AND kind = 'intent'
             ORDER BY project_id NULLS LAST, updated_at DESC",
        )?;
        let mut rows = stmt.query([])?;
        let mut groups: Vec<IntentGroup> = Vec::new();
        while let Some(row) = rows.next()? {
            let project_id: Option<String> = row.get("project_id")?;
            let item = IntentListItem {
                id: row.get("id")?,
                title: row.get::<_, String>("title")?,
                body_preview: row.get("body_preview")?,
                project_id: project_id.clone(),
            };
            match groups.last_mut() {
                Some(g) if g.project_id == project_id => g.items.push(item),
                _ => groups.push(IntentGroup {
                    project_id,
                    items: vec![item],
                }),
            }
        }
        Ok(groups)
    }

    fn list_timeline_items(
        &self,
        before: Option<&TimelineCursor>,
        since: Option<&str>,
        limit: usize,
    ) -> Result<Vec<TimelineItem>> {
        let mut conditions = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(cursor) = before {
            conditions.push(format!(
                "(timeline_at < ?{p1} OR (timeline_at = ?{p1} AND item_key < ?{p2}))",
                p1 = param_values.len() + 1,
                p2 = param_values.len() + 2,
            ));
            param_values.push(Box::new(cursor.timeline_at.clone()));
            param_values.push(Box::new(cursor.item_key.clone()));
        }

        if let Some(since_ts) = since {
            conditions.push(format!(
                "timeline_at >= ?{}",
                param_values.len() + 1
            ));
            param_values.push(Box::new(since_ts.to_string()));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let limit_param_idx = param_values.len() + 1;
        param_values.push(Box::new(limit as i64));

        let sql = format!(
            "SELECT item_kind, id, kind, title, body_preview, timeline_at, item_key FROM (
               SELECT 'artifact' AS item_kind,
                      id, kind, title,
                      substr(body_markdown, 1, 200) AS body_preview,
                      COALESCE(occurred_at, created_at) AS timeline_at,
                      'artifact:' || id AS item_key
               FROM library_entries WHERE state = 'saved'
               UNION ALL
               SELECT 'task_created', id, 'task', title, '', created_at, 'task_created:' || id
               FROM tasks
               UNION ALL
               SELECT 'task_closed', id, 'task', title, '', closed_at, 'task_closed:' || id
               FROM tasks WHERE closed_at IS NOT NULL
             )
             {where_clause}
             ORDER BY timeline_at DESC, item_key DESC
             LIMIT ?{limit_param_idx}"
        );

        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|b| b.as_ref()).collect();

        let mut stmt = self.conn().prepare(&sql)?;
        let mut rows = stmt.query(params_ref.as_slice())?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(timeline_item_from_row(row)?);
        }
        Ok(items)
    }

    fn insert_attachment(
        &mut self,
        entry_id: &str,
        original_file_name: &str,
        mime_type: Option<&str>,
        byte_size: i64,
        relative_path: &str,
    ) -> Result<Attachment> {
        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO attachment_counter DEFAULT VALUES", [])?;
        let id = format!("ATT-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO library_attachments (id, entry_id, original_file_name, mime_type, byte_size, relative_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, entry_id, original_file_name, mime_type, byte_size, relative_path],
        )?;
        let attachment = {
            let mut stmt = tx.prepare(
                "SELECT id, entry_id, original_file_name, mime_type, byte_size, relative_path, created_at
                 FROM library_attachments WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => attachment_from_row(row)?,
                None => return Err(anyhow!("inserted attachment {id} not found")),
            }
        };
        tx.commit()?;
        Ok(attachment)
    }

    fn delete_attachment(&mut self, id: &str) -> Result<Option<String>> {
        let path: Option<String> = self
            .conn()
            .query_row(
                "SELECT relative_path FROM library_attachments WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        self.conn()
            .execute("DELETE FROM library_attachments WHERE id = ?1", params![id])?;
        Ok(path)
    }

    fn list_attachments(&self, entry_id: &str) -> Result<Vec<Attachment>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, entry_id, original_file_name, mime_type, byte_size, relative_path, created_at
             FROM library_attachments WHERE entry_id = ?1 ORDER BY created_at",
        )?;
        let mut rows = stmt.query(params![entry_id])?;
        let mut attachments = Vec::new();
        while let Some(row) = rows.next()? {
            attachments.push(attachment_from_row(row)?);
        }
        Ok(attachments)
    }
}

fn kind_from_row(row: &rusqlite::Row<'_>) -> Result<(String, Option<String>, Option<String>)> {
    let kind: String = row.get("kind")?;
    let title: Option<String> = row.get("title")?;
    let project_id: Option<String> = row.get("project_id")?;
    Ok((kind, title, project_id))
}

fn draft_from_row(row: &rusqlite::Row<'_>) -> Result<ArtifactDraft> {
    let (kind_str, title, project_id) = kind_from_row(row)?;
    let kind = match kind_str.as_str() {
        "memo" => ArtifactDraftKind::Memo,
        "essay" => ArtifactDraftKind::Essay { title },
        "intent" => ArtifactDraftKind::Intent { title, project_id },
        other => bail!("unknown artifact kind: {other}"),
    };
    Ok(ArtifactDraft {
        id: row.get("id")?,
        kind,
        body: row.get("body_markdown")?,
        occurred_at: row.get("occurred_at")?,
        attachments: Vec::new(),
        revision: row.get("revision")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn delete_entry_with_attachments(store: &mut SqliteStore, id: &str, state: &str) -> Result<()> {
    let has_attachments = store.conn().query_row(
        "SELECT EXISTS (
             SELECT 1
             FROM library_entries e
             JOIN library_attachments a ON a.entry_id = e.id
             WHERE e.id = ?1 AND e.state = ?2
         )",
        params![id, state],
        |row| row.get::<_, i64>(0).map(|n| n != 0),
    )?;

    if has_attachments {
        remove_entry_attachment_dir(store, id)?;
    }

    store.conn().execute(
        "DELETE FROM library_entries WHERE id = ?1 AND state = ?2",
        params![id, state],
    )?;
    Ok(())
}

fn remove_entry_attachment_dir(store: &SqliteStore, entry_id: &str) -> Result<()> {
    let Some(base_dir) = store.attachment_base_dir() else {
        return Ok(());
    };
    let dir = base_dir.join("attachments").join(entry_id);
    remove_attachment_dir(&dir)
}

fn remove_attachment_dir(dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| {
            format!(
                "failed to remove attachment directory {}",
                dir.display()
            )
        }),
    }
}

fn artifact_from_row(row: &rusqlite::Row<'_>) -> Result<Artifact> {
    let (kind_str, title, project_id) = kind_from_row(row)?;
    let kind = match kind_str.as_str() {
        "memo" => ArtifactKind::Memo,
        "essay" => ArtifactKind::Essay {
            title: title.ok_or_else(|| anyhow!("essay missing title"))?,
        },
        "intent" => ArtifactKind::Intent {
            title: title.ok_or_else(|| anyhow!("intent missing title"))?,
            project_id,
        },
        other => bail!("unknown artifact kind: {other}"),
    };
    Ok(Artifact {
        id: row.get("id")?,
        kind,
        body: row.get("body_markdown")?,
        occurred_at: row.get("occurred_at")?,
        attachments: Vec::new(),
        revision: row.get("revision")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn attachment_from_row(row: &rusqlite::Row<'_>) -> Result<Attachment> {
    Ok(Attachment {
        id: row.get("id")?,
        entry_id: row.get("entry_id")?,
        original_file_name: row.get("original_file_name")?,
        mime_type: row.get("mime_type")?,
        byte_size: row.get("byte_size")?,
        relative_path: row.get("relative_path")?,
        created_at: row.get("created_at")?,
    })
}

fn timeline_item_from_row(row: &rusqlite::Row<'_>) -> Result<TimelineItem> {
    let item_kind: String = row.get("item_kind")?;
    let id: String = row.get("id")?;
    let title: Option<String> = row.get("title")?;
    let timeline_at: String = row.get("timeline_at")?;
    let item_key: String = row.get("item_key")?;

    match item_kind.as_str() {
        "artifact" => {
            let kind: String = row.get("kind")?;
            let body_preview: String = row.get("body_preview")?;
            Ok(TimelineItem::Artifact {
                entry_id: id,
                artifact_kind: kind,
                title,
                body_preview,
                timeline_at,
                item_key,
            })
        }
        "task_created" => Ok(TimelineItem::TaskCreated {
            task_id: id,
            title: title.unwrap_or_default(),
            timeline_at,
            item_key,
        }),
        "task_closed" => Ok(TimelineItem::TaskClosed {
            task_id: id,
            title: title.unwrap_or_default(),
            timeline_at,
            item_key,
        }),
        other => bail!("unknown timeline item kind: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::remove_attachment_dir;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("monica-{name}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn remove_attachment_dir_removes_files_and_allows_missing_dir() {
        let root = unique_temp_dir("attachment-dir");
        let entry_dir = root.join("attachments").join("ART-1");
        std::fs::create_dir_all(entry_dir.join("nested")).unwrap();
        std::fs::write(entry_dir.join("nested").join("image.png"), b"png").unwrap();

        remove_attachment_dir(&entry_dir).unwrap();
        assert!(!entry_dir.exists());

        remove_attachment_dir(&entry_dir).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
