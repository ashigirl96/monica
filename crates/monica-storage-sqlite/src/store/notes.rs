use anyhow::{anyhow, bail, Result};
use monica_application::ports::NoteStore;
use monica_domain::{
    logical_date, DailyNoteCount, Note, NoteId, NoteKind, NoteSummary, RawJson, UpdateNote,
};
use rusqlite::{params, Connection, Row};

use crate::SqliteStore;

use super::{NOTE_COLUMNS, SET_NOW};

const PREVIEW_MAX_CHARS: usize = 200;

/// note の「その日」の素材になるサーバーローカル時刻。タイムゾーン解決は SQLite に
/// 一任し、day boundary のシフトは domain の `logical_date` が担う。
const LOCAL_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%S','now','localtime')";

fn logical_today_on(conn: &Connection, day_boundary_hour: u8) -> Result<String> {
    let local_now: String = conn.query_row(&format!("SELECT {LOCAL_NOW}"), [], |r| r.get(0))?;
    logical_date(&local_now, day_boundary_hour)
        .ok_or_else(|| anyhow!("invalid localtime from sqlite: {local_now}"))
}

fn kind_from_columns(
    kind: &str,
    title: Option<String>,
    project_id: Option<String>,
) -> Result<NoteKind> {
    match (kind, project_id) {
        ("project", Some(project_id)) => Ok(NoteKind::Project { project_id }),
        // project の削除（FK ON DELETE SET NULL）で orphan 化した project note は
        // daily に退化して読む。元の date の daily として一覧に現れる。
        ("project", None) => Ok(NoteKind::Daily),
        ("daily", _) => Ok(NoteKind::Daily),
        ("essay", _) => Ok(NoteKind::Essay { title: title.unwrap_or_default() }),
        (other, _) => bail!("unknown note kind: {other}"),
    }
}

fn kind_from_row(row: &Row<'_>) -> Result<NoteKind> {
    let kind: String = row.get("kind")?;
    kind_from_columns(&kind, row.get("title")?, row.get("project_id")?)
}

fn note_from_row(row: &Row<'_>) -> Result<Note> {
    Ok(Note {
        id: NoteId::from_store(row.get("id")?),
        kind: kind_from_row(row)?,
        content: RawJson::from(row.get::<_, String>("content")?),
        date: row.get("date")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// First non-empty block of a ProseMirror doc, in document order. The schema is
/// `doc → blockGroup → blockContainer(blockContent, blockGroup?)`（shared/block-editor/schema.ts）
/// なので、blockContainer の先頭の子が常にその行の内容ノード — block type ごとの
/// 許可リストを持たずに済み、エディタに block type が増えてもここは変わらない。
fn first_line_preview(content: &str) -> Option<String> {
    fn collect_text(node: &serde_json::Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
            out.push_str(text);
        }
        if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
            for child in children {
                collect_text(child, out);
            }
        }
    }

    fn find_first_line(node: &serde_json::Value) -> Option<String> {
        let children = node.get("content").and_then(|c| c.as_array())?;
        if node.get("type").and_then(|t| t.as_str()) == Some("blockContainer") {
            let mut text = String::new();
            if let Some(block_content) = children.first() {
                collect_text(block_content, &mut text);
            }
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.chars().take(PREVIEW_MAX_CHARS).collect());
            }
            // 空行 — 続きは入れ子の blockGroup（あれば）から
            return children.iter().skip(1).find_map(find_first_line);
        }
        children.iter().find_map(find_first_line)
    }

    let doc: serde_json::Value = serde_json::from_str(content).ok()?;
    find_first_line(&doc)
}

fn summary_from_row(row: &Row<'_>) -> Result<NoteSummary> {
    let content: String = row.get("content")?;
    Ok(NoteSummary {
        id: NoteId::from_store(row.get("id")?),
        kind: kind_from_row(row)?,
        preview: first_line_preview(&content),
        date: row.get("date")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl NoteStore for SqliteStore {
    fn create_note(&mut self, day_boundary_hour: u8) -> Result<Note> {
        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO note_counter DEFAULT VALUES", [])?;
        let id = format!("note-{}", tx.last_insert_rowid());
        let date = logical_today_on(&tx, day_boundary_hour)?;
        // ビジネス上のデフォルト（kind・空 doc・date）はここで明示的に insert する。
        // v38 の DDL デフォルトはこの経路では使わない（frozen な migration に依存しない）。
        let note = tx.query_row(
            &format!(
                "INSERT INTO notes (id, kind, content, date) VALUES (?1, 'daily', ?2, ?3)
                 RETURNING {NOTE_COLUMNS}"
            ),
            params![id, monica_domain::EMPTY_NOTE_DOC, date],
            |row| Ok(note_from_row(row)),
        )??;
        tx.commit()?;
        Ok(note)
    }

    fn get_note(&self, id: &str) -> Result<Option<Note>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1 AND deleted_at IS NULL"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(note_from_row(row)?)),
            None => Ok(None),
        }
    }

    fn list_notes(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<NoteSummary>> {
        // `?1 IS NULL OR …` は non-sargable で notes_date_idx が効かないため COALESCE で範囲に落とす
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes
             WHERE deleted_at IS NULL
               AND date >= COALESCE(?1, '') AND date <= COALESCE(?2, '9999-12-31')
             ORDER BY date DESC, rowid DESC"
        ))?;
        let rows = stmt.query_map(params![from, to], |row| Ok(summary_from_row(row)))?;
        rows.map(|r| r?).collect()
    }

    fn list_project_notes(
        &self,
        project_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<NoteSummary>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes
             WHERE deleted_at IS NULL AND project_id = ?1
             ORDER BY date DESC, rowid DESC
             LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = stmt.query_map(params![project_id, limit as i64, offset as i64], |row| {
            Ok(summary_from_row(row))
        })?;
        rows.map(|r| r?).collect()
    }

    fn update_note(&mut self, id: &str, update: UpdateNote) -> Result<Option<Note>> {
        // title は essay のときだけ意味を持つ。CASE ガードにより、kind 遷移直後に着弾した
        // stale な autosave が daily/project に title を植え付けることはない。
        let mut stmt = self.conn().prepare(&format!(
            "UPDATE notes
             SET content = ?1,
                 title = CASE WHEN kind = 'essay' AND ?2 IS NOT NULL THEN ?2 ELSE title END,
                 updated_at = {SET_NOW}
             WHERE id = ?3 AND deleted_at IS NULL
             RETURNING {NOTE_COLUMNS}"
        ))?;
        let mut rows = stmt.query(params![update.content.as_str(), update.title, id])?;
        match rows.next()? {
            Some(row) => Ok(Some(note_from_row(row)?)),
            None => Ok(None),
        }
    }

    fn set_note_kind(
        &mut self,
        id: &str,
        expected_kind: &str,
        kind: &NoteKind,
    ) -> Result<Option<Note>> {
        // kind の一致を WHERE で確認する条件付き書き込み。呼び手が検証した遷移元から
        // 変わっていたら不発（並行遷移の後勝ち上書きを防ぐ）。
        let mut stmt = self.conn().prepare(&format!(
            "UPDATE notes
             SET kind = ?1, title = ?2, project_id = ?3, updated_at = {SET_NOW}
             WHERE id = ?4 AND deleted_at IS NULL AND kind = ?5
             RETURNING {NOTE_COLUMNS}"
        ))?;
        let mut rows = stmt.query(params![
            kind.name(),
            kind.title(),
            kind.project_id(),
            id,
            expected_kind
        ])?;
        match rows.next()? {
            Some(row) => Ok(Some(note_from_row(row)?)),
            None => Ok(None),
        }
    }

    fn delete_note(&mut self, id: &str) -> Result<bool> {
        let affected = self.conn().execute(
            &format!("UPDATE notes SET deleted_at = {SET_NOW} WHERE id = ?1 AND deleted_at IS NULL"),
            params![id],
        )?;
        Ok(affected > 0)
    }

    fn restore_note(&mut self, id: &str) -> Result<Option<Note>> {
        let mut stmt = self.conn().prepare(&format!(
            "UPDATE notes SET deleted_at = NULL WHERE id = ?1 RETURNING {NOTE_COLUMNS}"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(note_from_row(row)?)),
            None => Ok(None),
        }
    }

    fn daily_note_counts(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Vec<DailyNoteCount>> {
        let mut stmt = self.conn().prepare(
            "SELECT date, COUNT(*) AS count FROM notes
             WHERE deleted_at IS NULL
               AND date >= COALESCE(?1, '') AND date <= COALESCE(?2, '9999-12-31')
             GROUP BY date ORDER BY date ASC",
        )?;
        let rows = stmt.query_map(params![from, to], |row| {
            Ok(DailyNoteCount { date: row.get("date")?, count: row.get("count")? })
        })?;
        rows.map(|r| Ok(r?)).collect()
    }

    fn logical_today(&self, day_boundary_hour: u8) -> Result<String> {
        logical_today_on(self.conn(), day_boundary_hour)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_date(store: &SqliteStore, id: &str, date: &str) {
        store
            .conn()
            .execute("UPDATE notes SET date = ?1 WHERE id = ?2", params![date, id])
            .unwrap();
    }

    fn seed_project(store: &SqliteStore, id: &str) {
        store
            .conn()
            .execute(
                "INSERT INTO projects (id, name, repo) VALUES (?1, 'r', ?1)",
                params![id],
            )
            .unwrap();
    }

    fn doc_with_text(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"blockGroup","content":[{{"type":"blockContainer","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}]}}]}}]}}"#
        )
    }

    fn content_update(text: &str) -> UpdateNote {
        UpdateNote { title: None, content: RawJson::from(doc_with_text(text)) }
    }

    #[test]
    fn create_uses_defaults_and_logical_today() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        for boundary in [0u8, 23] {
            let before = store.logical_today(boundary).unwrap();
            let note = store.create_note(boundary).unwrap();
            let after = store.logical_today(boundary).unwrap();
            assert_eq!(note.kind, NoteKind::Daily);
            assert_eq!(note.content.as_str(), monica_domain::EMPTY_NOTE_DOC);
            // 日付の跨ぎ・境界秒のレースに耐えるよう、直前直後の logical today と突き合わせる
            assert!(
                note.date == before || note.date == after,
                "date {} not in [{before}, {after}]",
                note.date
            );
            assert!(!note.created_at.is_empty());
            assert_eq!(note.created_at, note.updated_at);
        }
    }

    #[test]
    fn logical_today_format() {
        let store = SqliteStore::open_in_memory().unwrap();
        let today = store.logical_today(0).unwrap();
        assert_eq!(today.len(), 10);
        assert!(today.chars().all(|c| c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn ids_increment_and_survive_delete() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let n1 = store.create_note(0).unwrap();
        store.delete_note(n1.id.as_str()).unwrap();
        let n2 = store.create_note(0).unwrap();
        assert_eq!(n1.id, "note-1");
        assert_eq!(n2.id, "note-2");
    }

    #[test]
    fn soft_delete_hides_and_restore_brings_back() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();

        store.delete_note(id).unwrap();
        assert!(store.get_note(id).unwrap().is_none());
        assert!(store.list_notes(None, None).unwrap().is_empty());
        assert!(store.daily_note_counts(None, None).unwrap().is_empty());
        // 削除済みへの update / kind 変更は不発（autosave の残弾で復活させない）
        assert!(store.update_note(id, content_update("zombie")).unwrap().is_none());
        assert!(store
            .set_note_kind(id, "daily", &NoteKind::Essay { title: "zombie".to_string() })
            .unwrap()
            .is_none());

        let restored = store.restore_note(id).unwrap().unwrap();
        assert_eq!(restored.id, note.id);
        assert_eq!(restored.kind, NoteKind::Daily, "delete/restore で内容は変わらない");
        assert_eq!(store.list_notes(None, None).unwrap().len(), 1);

        assert!(store.restore_note("note-999").unwrap().is_none());
    }

    #[test]
    fn get_existing_and_missing() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        assert!(store.get_note("note-1").unwrap().is_some());
        assert!(store.get_note("note-999").unwrap().is_none());
    }

    #[test]
    fn update_round_trips_and_bumps_updated_at() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.create_note(0).unwrap();
        // updated_at は ms 精度なので、同一 tick でも変化が見えるよう過去に倒しておく。
        store
            .conn()
            .execute(
                "UPDATE notes SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
                params![note.id.as_str()],
            )
            .unwrap();

        let updated = store.update_note(note.id.as_str(), content_update("hello")).unwrap().unwrap();
        assert_eq!(updated.content.as_str(), doc_with_text("hello"));
        assert!(updated.updated_at.as_str() > "2000-01-01T00:00:00.000Z");
        assert_eq!(updated.date, note.date, "date is fixed at creation");
    }

    #[test]
    fn update_title_only_applies_to_essays() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");

        // daily: title は無視される
        let daily = store.create_note(0).unwrap();
        let update = UpdateNote {
            title: Some("ignored".to_string()),
            content: RawJson::from(doc_with_text("body")),
        };
        let updated = store.update_note(daily.id.as_str(), update.clone()).unwrap().unwrap();
        assert_eq!(updated.kind, NoteKind::Daily);
        assert_eq!(updated.kind.title(), None);

        // project: title は無視される
        let project = store.create_note(0).unwrap();
        store
            .set_note_kind(project.id.as_str(), "daily", &NoteKind::Project { project_id: "o/r".to_string() })
            .unwrap()
            .unwrap();
        let updated = store.update_note(project.id.as_str(), update.clone()).unwrap().unwrap();
        assert_eq!(updated.kind, NoteKind::Project { project_id: "o/r".to_string() });

        // essay: Some は置換、None は keep
        let essay = store.create_note(0).unwrap();
        store
            .set_note_kind(essay.id.as_str(), "daily", &NoteKind::Essay { title: String::new() })
            .unwrap()
            .unwrap();
        let updated = store.update_note(essay.id.as_str(), update).unwrap().unwrap();
        assert_eq!(updated.kind, NoteKind::Essay { title: "ignored".to_string() });
        let kept = store.update_note(essay.id.as_str(), content_update("more")).unwrap().unwrap();
        assert_eq!(kept.kind, NoteKind::Essay { title: "ignored".to_string() }, "None keeps title");
        // 空文字への置換（無題化）も通る
        let cleared = store
            .update_note(
                essay.id.as_str(),
                UpdateNote {
                    title: Some(String::new()),
                    content: RawJson::from(doc_with_text("more")),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(cleared.kind, NoteKind::Essay { title: String::new() });
    }

    #[test]
    fn set_note_kind_writes_payload_columns() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();

        let essay = store
            .set_note_kind(id, "daily", &NoteKind::Essay { title: "t".to_string() })
            .unwrap()
            .unwrap();
        assert_eq!(essay.kind, NoteKind::Essay { title: "t".to_string() });

        let daily = store.set_note_kind(id, "essay", &NoteKind::Daily).unwrap().unwrap();
        assert_eq!(daily.kind, NoteKind::Daily);
        let title: Option<String> = store
            .conn()
            .query_row("SELECT title FROM notes WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(title, None, "daily 化で title 列も NULL に戻る");

        let project = store
            .set_note_kind(id, "daily", &NoteKind::Project { project_id: "o/r".to_string() })
            .unwrap()
            .unwrap();
        assert_eq!(project.kind, NoteKind::Project { project_id: "o/r".to_string() });

        assert!(store.set_note_kind("note-999", "daily", &NoteKind::Daily).unwrap().is_none());
    }

    #[test]
    fn set_note_kind_rejects_unknown_project_via_fk() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.create_note(0).unwrap();
        assert!(store
            .set_note_kind(
                note.id.as_str(),
                "daily",
                &NoteKind::Project { project_id: "o/missing".to_string() }
            )
            .is_err());
    }

    #[test]
    fn set_note_kind_is_conditional_on_expected_kind() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();
        store
            .set_note_kind(id, "daily", &NoteKind::Project { project_id: "o/r".to_string() })
            .unwrap()
            .unwrap();

        // 遷移元が変わっていたら不発: daily 前提で検証済みの並行遷移は project を上書きできない
        let stale = store
            .set_note_kind(id, "daily", &NoteKind::Essay { title: String::new() })
            .unwrap();
        assert!(stale.is_none());
        let read = store.get_note(id).unwrap().unwrap();
        assert_eq!(read.kind, NoteKind::Project { project_id: "o/r".to_string() });
    }

    #[test]
    fn orphaned_project_note_reads_as_daily() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        let note = store.create_note(0).unwrap();
        store
            .set_note_kind(note.id.as_str(), "daily", &NoteKind::Project { project_id: "o/r".to_string() })
            .unwrap()
            .unwrap();

        store.conn().execute("DELETE FROM projects WHERE id = 'o/r'", []).unwrap();
        let read = store.get_note(note.id.as_str()).unwrap().unwrap();
        assert_eq!(read.kind, NoteKind::Daily, "ON DELETE SET NULL → daily 退化");
    }

    #[test]
    fn update_missing_returns_none() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        assert!(store.update_note("note-999", content_update("x")).unwrap().is_none());
    }

    #[test]
    fn list_filters_by_date_range_and_orders_desc() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        for _ in 0..3 {
            store.create_note(0).unwrap();
        }
        set_date(&store, "note-1", "2026-07-10");
        set_date(&store, "note-2", "2026-07-12");
        set_date(&store, "note-3", "2026-07-14");

        let all = store.list_notes(None, None).unwrap();
        assert_eq!(
            all.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["note-3", "note-2", "note-1"]
        );

        let ranged = store.list_notes(Some("2026-07-11"), Some("2026-07-13")).unwrap();
        assert_eq!(ranged.len(), 1);
        assert_eq!(ranged[0].id, "note-2");
    }

    #[test]
    fn list_orders_same_day_newest_first() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.create_note(0).unwrap();
        let list = store.list_notes(None, None).unwrap();
        assert_eq!(
            list.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["note-2", "note-1"]
        );
    }

    #[test]
    fn list_derives_preview_from_content() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.create_note(0).unwrap();
        store.update_note(note.id.as_str(), content_update("最初の行だよ")).unwrap();
        let list = store.list_notes(None, None).unwrap();
        assert_eq!(list[0].preview.as_deref(), Some("最初の行だよ"));
    }

    #[test]
    fn list_project_notes_filters_pages_and_skips_deleted() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        for _ in 0..4 {
            store.create_note(0).unwrap();
        }
        // note-1..3 を o/r に、note-4 は project なしのまま
        for id in ["note-1", "note-2", "note-3"] {
            store
                .set_note_kind(id, "daily", &NoteKind::Project { project_id: "o/r".to_string() })
                .unwrap()
                .unwrap();
        }
        set_date(&store, "note-1", "2026-07-10");
        set_date(&store, "note-2", "2026-07-12");
        set_date(&store, "note-3", "2026-07-14");
        store.delete_note("note-2").unwrap();

        let ids = |list: Vec<NoteSummary>| list.into_iter().map(|s| s.id.into_string()).collect::<Vec<_>>();
        assert_eq!(
            ids(store.list_project_notes("o/r", 10, 0).unwrap()),
            vec!["note-3", "note-1"],
            "project 外と削除済みは出ない・新しい日付が先"
        );
        assert_eq!(ids(store.list_project_notes("o/r", 1, 0).unwrap()), vec!["note-3"]);
        assert_eq!(ids(store.list_project_notes("o/r", 1, 1).unwrap()), vec!["note-1"]);
        assert!(store.list_project_notes("o/r", 10, 2).unwrap().is_empty());
        assert!(store.list_project_notes("o/none", 10, 0).unwrap().is_empty());
    }

    #[test]
    fn daily_counts_group_by_date() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        for _ in 0..4 {
            store.create_note(0).unwrap();
        }
        set_date(&store, "note-1", "2026-07-10");
        set_date(&store, "note-2", "2026-07-10");
        set_date(&store, "note-3", "2026-07-12");
        set_date(&store, "note-4", "2026-07-20");

        let counts = store.daily_note_counts(Some("2026-07-01"), Some("2026-07-15")).unwrap();
        assert_eq!(
            counts,
            vec![
                DailyNoteCount { date: "2026-07-10".to_string(), count: 2 },
                DailyNoteCount { date: "2026-07-12".to_string(), count: 1 },
            ]
        );
    }

    #[test]
    fn kind_from_columns_covers_all_shapes() {
        assert_eq!(
            kind_from_columns("project", None, Some("o/r".to_string())).unwrap(),
            NoteKind::Project { project_id: "o/r".to_string() }
        );
        assert_eq!(kind_from_columns("project", None, None).unwrap(), NoteKind::Daily);
        assert_eq!(kind_from_columns("daily", None, None).unwrap(), NoteKind::Daily);
        assert_eq!(
            kind_from_columns("essay", Some("t".to_string()), None).unwrap(),
            NoteKind::Essay { title: "t".to_string() }
        );
        assert_eq!(
            kind_from_columns("essay", None, None).unwrap(),
            NoteKind::Essay { title: String::new() },
            "NULL title は無題として読む"
        );
        assert!(kind_from_columns("memo", None, None).is_err(), "v40 後に旧 kind は存在しない");
    }

    #[test]
    fn preview_empty_doc_is_none() {
        assert_eq!(first_line_preview(r#"{"type":"doc","content":[]}"#), None);
    }

    #[test]
    fn preview_skips_empty_first_block() {
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"paragraph"}]},
            {"type":"blockContainer","content":[{"type":"paragraph","content":[{"type":"text","text":"second"}]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("second".to_string()));
    }

    #[test]
    fn preview_concatenates_inline_marks_within_one_block() {
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"heading","attrs":{"level":1},"content":[
                {"type":"text","text":"bold"},{"type":"text","marks":[{"type":"em"}],"text":" and em"}
            ]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("bold and em".to_string()));
    }

    #[test]
    fn preview_is_block_type_agnostic() {
        // blockContainer の先頭の子を行として扱うので、quote や未知の block type でも拾える
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"quote","content":[{"type":"text","text":"quoted"}]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("quoted".to_string()));
    }

    #[test]
    fn preview_truncates_on_char_boundary() {
        let long = "あ".repeat(300);
        let preview = first_line_preview(&doc_with_text(&long)).unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS);
    }

    #[test]
    fn preview_garbage_is_none() {
        assert_eq!(first_line_preview("not json"), None);
    }
}
