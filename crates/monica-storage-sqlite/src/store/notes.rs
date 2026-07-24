use anyhow::{anyhow, bail, Result};
use monica_application::ports::NoteStore;
use monica_domain::{
    block_subtree, first_line_preview, logical_date, plain_text, DailyNoteCount, EssayStatus,
    Note, NoteId, NoteKind, NoteSummary, RawJson, UpdateNote,
};
use rusqlite::{params, Connection, Row, TransactionBehavior};

use crate::SqliteStore;

use super::{NOTE_COLUMNS, SET_NOW};

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
    status: Option<String>,
) -> Result<NoteKind> {
    match (kind, project_id) {
        ("project", Some(project_id)) => {
            Ok(NoteKind::Project { project_id, title: title.unwrap_or_default() })
        }
        // project の削除（FK ON DELETE SET NULL）で orphan 化した project note は
        // daily に退化して読む。元の date の daily として一覧に現れる。
        ("project", None) => Ok(NoteKind::Daily),
        ("daily", _) => Ok(NoteKind::Daily),
        ("essay", _) => {
            // NULL = writing（v42 は backfill しない）。既知外の値は黙って既定に
            // 倒さず Err にする（手動 SQL の typo を読み取りで隠さない）。
            let status = match status {
                None => EssayStatus::Writing,
                Some(s) => EssayStatus::parse(&s)
                    .ok_or_else(|| anyhow!("unknown essay status: {s}"))?,
            };
            Ok(NoteKind::Essay { title: title.unwrap_or_default(), status })
        }
        (other, _) => bail!("unknown note kind: {other}"),
    }
}

fn kind_from_row(row: &Row<'_>) -> Result<NoteKind> {
    let kind: String = row.get("kind")?;
    kind_from_columns(&kind, row.get("title")?, row.get("project_id")?, row.get("status")?)
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

/// "note-42" → 42。notes_fts の rowid（本文行の O(log n) 更新キー）。id は create_note が
/// 必ず `note-{rowid}` で発番するので、この分解は常に成立する。
fn fts_rowid(id: &str) -> Result<i64> {
    id.strip_prefix("note-")
        .and_then(|n| n.parse::<i64>().ok())
        .ok_or_else(|| anyhow!("note id is not canonical: {id}"))
}

/// note 本文の FTS 行を張り替える（FTS5 に upsert が無いので DELETE → INSERT）。
/// body は `plain_text` 投影のみ。schema 語彙（`paragraph` 等）が索引に載らないのがミソ。
fn upsert_note_fts(conn: &Connection, id: &str, content: &str) -> Result<()> {
    let rowid = fts_rowid(id)?;
    conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![rowid])?;
    conn.execute(
        "INSERT INTO notes_fts (rowid, body, note_id) VALUES (?1, ?2, ?3)",
        params![rowid, plain_text(content), id],
    )?;
    Ok(())
}

/// ユーザー入力を FTS5 の phrase クエリに包む。`"` を二重化して 1 個の phrase にし、
/// クエリ演算子（`OR` / `*` / `-` 等）をリテラル扱いにする。
fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

/// LIKE パターンの特殊文字（`\` `%` `_`）をエスケープする。`ESCAPE '\'` 節と併用し、
/// ユーザー入力をリテラル substring として扱う（`note search "a_"` が全件に化けない）。
fn like_escape(query: &str) -> String {
    query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// v41 以前の既存 note を FTS に一括索引する。冪等: 索引済み DB では何もしない。
/// per-operation で open される store（web 全ハンドラ・毎秒 autosave・CLI/hook）から init 経由で
/// 毎回呼ばれるので、まず write lock 不要の read プローブで抜ける（backfill が実際に走るのは
/// v41 跨ぎ直後の一度きり）。索引が空のときだけ `Immediate` tx で write lock を先取りし、
/// tx 内でゲートを再評価して並行 open による二重 backfill（rowid 重複）を防ぐ。
pub(crate) fn backfill_notes_fts(conn: &mut Connection) -> Result<()> {
    let already_indexed: bool =
        conn.query_row("SELECT EXISTS(SELECT 1 FROM notes_fts)", [], |r| r.get(0))?;
    if already_indexed {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let fts_empty: bool =
        tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM notes_fts)", [], |r| r.get(0))?;
    let notes_present: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM notes)", [], |r| r.get(0))?;
    if fts_empty && notes_present {
        let rows: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT id, content FROM notes")?;
            let mapped = stmt.query_map([], |row| Ok((row.get("id")?, row.get("content")?)))?;
            mapped.collect::<rusqlite::Result<_>>()?
        };
        for (id, content) in rows {
            upsert_note_fts(&tx, &id, &content)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// counter 採番 → INSERT → FTS 行確立。create_note / get_or_create_daily_note が
/// 共有する作成経路（tx は呼び手が張る）。
fn insert_daily_note(conn: &Connection, date: &str) -> Result<Note> {
    conn.execute("INSERT INTO note_counter DEFAULT VALUES", [])?;
    let id = format!("note-{}", conn.last_insert_rowid());
    // ビジネス上のデフォルト（kind・空 doc・date）はここで明示的に insert する。
    // v38 の DDL デフォルトはこの経路では使わない（frozen な migration に依存しない）。
    let note = conn.query_row(
        &format!(
            "INSERT INTO notes (id, kind, content, date) VALUES (?1, 'daily', ?2, ?3)
             RETURNING {NOTE_COLUMNS}"
        ),
        params![id, monica_domain::EMPTY_NOTE_DOC, date],
        |row| Ok(note_from_row(row)),
    )??;
    // 全 note が FTS 行を持つ不変条件をここで確立する（backfill ゲートの前提）。
    upsert_note_fts(conn, &id, monica_domain::EMPTY_NOTE_DOC)?;
    Ok(note)
}

impl NoteStore for SqliteStore {
    fn create_note(&mut self, day_boundary_hour: u8) -> Result<Note> {
        let tx = self.conn_mut().transaction()?;
        let date = logical_today_on(&tx, day_boundary_hour)?;
        let note = insert_daily_note(&tx, &date)?;
        tx.commit()?;
        Ok(note)
    }

    fn get_or_create_daily_note(&mut self, date: &str) -> Result<Note> {
        // Immediate で tx 開始時点から write lock を取る。store は per-request に open
        // されるため、並行する get-or-create はここで直列化され、SELECT と INSERT の
        // 間に他の作成が割り込めない（後着は先着の commit 済み行を SELECT で拾う）。
        let tx = self.conn_mut().transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {NOTE_COLUMNS} FROM notes
                 WHERE kind = 'daily' AND date = ?1 AND deleted_at IS NULL
                 ORDER BY rowid ASC LIMIT 1"
            ))?;
            let mut rows = stmt.query(params![date])?;
            match rows.next()? {
                Some(row) => Some(note_from_row(row)?),
                None => None,
            }
        };
        let note = match existing {
            // 同日に複数の live daily がある場合（旧 /notes の ⌥N 経路の遺産）は
            // 最古（rowid 最小）で決定的に選ぶ — 手動マージ手順の「最古を残す」と一致。
            Some(note) => note,
            None => insert_daily_note(&tx, date)?,
        };
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

    fn get_note_block(&self, note_id: &str, block_id: &str) -> Result<Option<RawJson>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT content FROM notes WHERE id = ?1 AND deleted_at IS NULL")?;
        let mut rows = stmt.query(params![note_id])?;
        match rows.next()? {
            Some(row) => {
                let content: String = row.get(0)?;
                Ok(block_subtree(&content, block_id).map(RawJson::from))
            }
            None => Ok(None),
        }
    }

    fn list_all_note_contents(&self) -> Result<Vec<RawJson>> {
        // deleted_at フィルタなし: soft-delete された note の asset 参照も「生存」扱いにするため。
        let mut stmt = self.conn().prepare("SELECT content FROM notes")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for content in rows {
            out.push(RawJson::from(content?));
        }
        Ok(out)
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

    fn search_notes(&self, q: &str, limit: usize) -> Result<Vec<NoteSummary>> {
        // coarse な superset を返すだけ（正確な絞り込みは facade）。title/project_id/date は
        // 従来どおり LIKE、本文は FTS5（plain_text 投影）に載せ替えてスキーマ語彙偽陽性を消す。
        // 空 q は date（非 NULL）に必ず一致し「最近ノート」一覧を兼ねる。
        // 既知の制限: 空 title essay の display_name "Untitled" は導出値でどの列にも
        // 現れないため、"unt" 等の検索は coarse で落ちる（superset が破れる唯一のケース）。
        if q.is_empty() {
            // 空 q は全 note を最近順で（FTS を経由しない）。
            let mut stmt = self.conn().prepare(&format!(
                "SELECT {NOTE_COLUMNS} FROM notes
                 WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC, rowid DESC
                 LIMIT ?1"
            ))?;
            let rows = stmt.query_map(params![limit as i64], |row| Ok(summary_from_row(row)))?;
            return rows.map(|r| r?).collect();
        }
        // trigram は 3-gram なので 3 文字（codepoint）未満は MATCH 不能 → plain_text body への
        // LIKE で拾う。byte 長で判定すると日本語 2 文字が MATCH 分岐に流れ静かに 0 件になる。
        // LIKE 節は `?1`（エスケープ済み）+ `ESCAPE '\'` でユーザー入力をリテラル扱いにする
        // （full-text search は facade で再フィルタしないので `_`/`%` の過剰マッチを防ぐ）。
        let use_match = q.chars().count() >= 3;
        let body_clause = if use_match {
            "id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?2)"
        } else {
            "id IN (SELECT note_id FROM notes_fts WHERE body LIKE '%'||?1||'%' ESCAPE '\\')"
        };
        // `?2`（MATCH phrase）は use_match のときだけ SQL に現れる。LIKE 分岐では phrase を
        // 組み立てず、未使用の bind に無害な空文字を渡す。
        let phrase = if use_match { fts_phrase(q) } else { String::new() };
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes
             WHERE deleted_at IS NULL
               AND (title LIKE '%'||?1||'%' ESCAPE '\\'
                    OR project_id LIKE '%'||?1||'%' ESCAPE '\\'
                    OR date LIKE '%'||?1||'%' ESCAPE '\\' OR {body_clause})
             ORDER BY updated_at DESC, rowid DESC
             LIMIT ?3"
        ))?;
        let rows = stmt.query_map(params![like_escape(q), phrase, limit as i64], |row| {
            Ok(summary_from_row(row))
        })?;
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
        // 本文更新と FTS 索引更新を 1 tx で atomic に行う（検索が古い本文にヒットしない）。
        let tx = self.conn_mut().transaction()?;
        let note = {
            let mut stmt = tx.prepare(&format!(
                "UPDATE notes
                 SET content = ?1,
                     title = CASE WHEN kind = 'essay' AND ?2 IS NOT NULL THEN ?2 ELSE title END,
                     updated_at = {SET_NOW}
                 WHERE id = ?3 AND deleted_at IS NULL
                 RETURNING {NOTE_COLUMNS}"
            ))?;
            let mut rows = stmt.query(params![update.content.as_str(), update.title, id])?;
            match rows.next()? {
                Some(row) => Some(note_from_row(row)?),
                None => None,
            }
        };
        if note.is_some() {
            upsert_note_fts(&tx, id, update.content.as_str())?;
        }
        tx.commit()?;
        Ok(note)
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
             SET kind = ?1, title = ?2, project_id = ?3, status = ?4, updated_at = {SET_NOW}
             WHERE id = ?5 AND deleted_at IS NULL AND kind = ?6
             RETURNING {NOTE_COLUMNS}"
        ))?;
        let mut rows = stmt.query(params![
            kind.name(),
            kind.title(),
            kind.project_id(),
            kind.status().map(EssayStatus::as_str),
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
        kind: Option<&str>,
    ) -> Result<Vec<DailyNoteCount>> {
        let mut stmt = self.conn().prepare(
            "SELECT date, COUNT(*) AS count FROM notes
             WHERE deleted_at IS NULL
               AND date >= COALESCE(?1, '') AND date <= COALESCE(?2, '9999-12-31')
               AND (?3 IS NULL OR kind = ?3)
             GROUP BY date ORDER BY date ASC",
        )?;
        let rows = stmt.query_map(params![from, to, kind], |row| {
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
        assert!(store.daily_note_counts(None, None, None).unwrap().is_empty());
        // 削除済みへの update / kind 変更は不発（autosave の残弾で復活させない）
        assert!(store.update_note(id, content_update("zombie")).unwrap().is_none());
        assert!(store
            .set_note_kind(id, "daily", &NoteKind::Essay { title: "zombie".to_string(), status: EssayStatus::Writing })
            .unwrap()
            .is_none());

        let restored = store.restore_note(id).unwrap().unwrap();
        assert_eq!(restored.id, note.id);
        assert_eq!(restored.kind, NoteKind::Daily, "delete/restore で内容は変わらない");
        assert_eq!(store.list_notes(None, None).unwrap().len(), 1);

        assert!(store.restore_note("note-999").unwrap().is_none());
    }

    #[test]
    fn list_all_note_contents_includes_soft_deleted() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let live = store.create_note(0).unwrap();
        store.update_note(live.id.as_str(), content_update("live body")).unwrap();
        let gone = store.create_note(0).unwrap();
        store.update_note(gone.id.as_str(), content_update("deleted body")).unwrap();
        store.delete_note(gone.id.as_str()).unwrap();

        // list_notes は soft-delete を除外するが、GC 用の走査は復活可能な note も含める。
        assert_eq!(store.list_notes(None, None).unwrap().len(), 1);
        let contents: Vec<String> =
            store.list_all_note_contents().unwrap().into_iter().map(|c| c.into_string()).collect();
        assert_eq!(contents.len(), 2);
        assert!(contents.iter().any(|c| c.contains("live body")));
        assert!(contents.iter().any(|c| c.contains("deleted body")));
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
            .set_note_kind(project.id.as_str(), "daily", &NoteKind::Project { project_id: "o/r".to_string(), title: String::new() })
            .unwrap()
            .unwrap();
        let updated = store.update_note(project.id.as_str(), update.clone()).unwrap().unwrap();
        assert_eq!(updated.kind, NoteKind::Project { project_id: "o/r".to_string(), title: String::new() });

        // essay: Some は置換、None は keep
        let essay = store.create_note(0).unwrap();
        store
            .set_note_kind(essay.id.as_str(), "daily", &NoteKind::Essay { title: String::new(), status: EssayStatus::Writing })
            .unwrap()
            .unwrap();
        let updated = store.update_note(essay.id.as_str(), update).unwrap().unwrap();
        assert_eq!(updated.kind, NoteKind::Essay { title: "ignored".to_string(), status: EssayStatus::Writing });
        let kept = store.update_note(essay.id.as_str(), content_update("more")).unwrap().unwrap();
        assert_eq!(kept.kind, NoteKind::Essay { title: "ignored".to_string(), status: EssayStatus::Writing }, "None keeps title");
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
        assert_eq!(cleared.kind, NoteKind::Essay { title: String::new(), status: EssayStatus::Writing });
    }

    #[test]
    fn set_note_kind_writes_payload_columns() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();

        let essay = store
            .set_note_kind(id, "daily", &NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing })
            .unwrap()
            .unwrap();
        assert_eq!(essay.kind, NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing });

        let daily = store.set_note_kind(id, "essay", &NoteKind::Daily).unwrap().unwrap();
        assert_eq!(daily.kind, NoteKind::Daily);
        let title: Option<String> = store
            .conn()
            .query_row("SELECT title FROM notes WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(title, None, "daily 化で title 列も NULL に戻る");

        let project = store
            .set_note_kind(id, "daily", &NoteKind::Project { project_id: "o/r".to_string(), title: String::new() })
            .unwrap()
            .unwrap();
        assert_eq!(project.kind, NoteKind::Project { project_id: "o/r".to_string(), title: String::new() });

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
                &NoteKind::Project { project_id: "o/missing".to_string(), title: String::new() }
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
            .set_note_kind(id, "daily", &NoteKind::Project { project_id: "o/r".to_string(), title: String::new() })
            .unwrap()
            .unwrap();

        // 遷移元が変わっていたら不発: daily 前提で検証済みの並行遷移は project を上書きできない
        let stale = store
            .set_note_kind(id, "daily", &NoteKind::Essay { title: String::new(), status: EssayStatus::Writing })
            .unwrap();
        assert!(stale.is_none());
        let read = store.get_note(id).unwrap().unwrap();
        assert_eq!(read.kind, NoteKind::Project { project_id: "o/r".to_string(), title: String::new() });
    }

    #[test]
    fn orphaned_project_note_reads_as_daily() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        let note = store.create_note(0).unwrap();
        store
            .set_note_kind(note.id.as_str(), "daily", &NoteKind::Project { project_id: "o/r".to_string(), title: String::new() })
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
                .set_note_kind(id, "daily", &NoteKind::Project { project_id: "o/r".to_string(), title: String::new() })
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

    fn set_updated_at(store: &SqliteStore, id: &str, updated_at: &str) {
        store
            .conn()
            .execute("UPDATE notes SET updated_at = ?1 WHERE id = ?2", params![updated_at, id])
            .unwrap();
    }

    #[test]
    fn search_matches_title_project_date_and_content() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "owner/repo");
        for _ in 0..4 {
            store.create_note(0).unwrap();
        }
        store
            .set_note_kind("note-1", "daily", &NoteKind::Essay { title: "Rust 設計メモ".to_string(), status: EssayStatus::Writing })
            .unwrap()
            .unwrap();
        store
            .set_note_kind(
                "note-2",
                "daily",
                &NoteKind::Project { project_id: "owner/repo".to_string(), title: String::new() },
            )
            .unwrap()
            .unwrap();
        set_date(&store, "note-3", "2025-12-31");
        store.update_note("note-4", content_update("本文だけの daily")).unwrap();

        let ids = |list: Vec<NoteSummary>| {
            list.into_iter().map(|s| s.id.into_string()).collect::<Vec<_>>()
        };
        assert_eq!(ids(store.search_notes("設計", 10).unwrap()), vec!["note-1"]);
        assert_eq!(ids(store.search_notes("owner/repo", 10).unwrap()), vec!["note-2"]);
        assert_eq!(ids(store.search_notes("2025-12", 10).unwrap()), vec!["note-3"]);
        assert_eq!(ids(store.search_notes("本文だけ", 10).unwrap()), vec!["note-4"]);
        assert!(store.search_notes("該当なし", 10).unwrap().is_empty());
    }

    #[test]
    fn search_empty_query_lists_recent_first_with_limit() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        for _ in 0..3 {
            store.create_note(0).unwrap();
        }
        set_updated_at(&store, "note-1", "2026-07-01T00:00:00.000Z");
        set_updated_at(&store, "note-2", "2026-07-03T00:00:00.000Z");
        set_updated_at(&store, "note-3", "2026-07-02T00:00:00.000Z");

        let ids = |list: Vec<NoteSummary>| {
            list.into_iter().map(|s| s.id.into_string()).collect::<Vec<_>>()
        };
        assert_eq!(
            ids(store.search_notes("", 10).unwrap()),
            vec!["note-2", "note-3", "note-1"],
            "空 q は全件を updated_at 降順で"
        );
        assert_eq!(ids(store.search_notes("", 2).unwrap()), vec!["note-2", "note-3"]);
    }

    #[test]
    fn search_skips_deleted() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.create_note(0).unwrap();
        store.delete_note("note-1").unwrap();
        let found = store.search_notes("", 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "note-2");
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

        let counts = store.daily_note_counts(Some("2026-07-01"), Some("2026-07-15"), None).unwrap();
        assert_eq!(
            counts,
            vec![
                DailyNoteCount { date: "2026-07-10".to_string(), count: 2 },
                DailyNoteCount { date: "2026-07-12".to_string(), count: 1 },
            ]
        );
    }

    #[test]
    fn get_or_create_daily_creates_then_returns_same() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let created = store.get_or_create_daily_note("2026-07-20").unwrap();
        assert_eq!(created.kind, NoteKind::Daily);
        assert_eq!(created.date, "2026-07-20");
        assert_eq!(created.content.as_str(), monica_domain::EMPTY_NOTE_DOC);

        let again = store.get_or_create_daily_note("2026-07-20").unwrap();
        assert_eq!(again.id, created.id, "冪等: 2 回目は既存を返す");
        assert_eq!(store.list_notes(None, None).unwrap().len(), 1);

        let other_day = store.get_or_create_daily_note("2026-07-21").unwrap();
        assert_ne!(other_day.id, created.id);
    }

    #[test]
    fn get_or_create_daily_picks_oldest_of_duplicates() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.create_note(0).unwrap();
        set_date(&store, "note-1", "2026-07-20");
        set_date(&store, "note-2", "2026-07-20");

        let picked = store.get_or_create_daily_note("2026-07-20").unwrap();
        assert_eq!(picked.id, "note-1", "同日重複（旧 ⌥N 経路の遺産）は最古を決定的に選ぶ");
    }

    #[test]
    fn get_or_create_daily_ignores_soft_deleted_and_other_kinds() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let deleted = store.get_or_create_daily_note("2026-07-20").unwrap();
        store.delete_note(deleted.id.as_str()).unwrap();
        let essay = store.create_note(0).unwrap();
        store
            .set_note_kind(
                essay.id.as_str(),
                "daily",
                &NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing },
            )
            .unwrap()
            .unwrap();
        set_date(&store, essay.id.as_str(), "2026-07-20");

        let fresh = store.get_or_create_daily_note("2026-07-20").unwrap();
        assert_ne!(fresh.id, deleted.id, "soft-delete 済み daily は拾わず新規作成");
        assert_ne!(fresh.id, essay.id, "同日の essay は対象外");
        assert_eq!(fresh.kind, NoteKind::Daily);
    }

    #[test]
    fn get_or_create_daily_establishes_fts_row() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.get_or_create_daily_note("2026-07-20").unwrap();
        store.update_note(note.id.as_str(), content_update("searchable body")).unwrap();
        assert_eq!(search_ids(&store, "searchable"), vec![note.id.as_str().to_string()]);
    }

    #[test]
    fn set_note_kind_status_round_trip() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();
        let raw_status = |store: &SqliteStore| -> Option<String> {
            store
                .conn()
                .query_row("SELECT status FROM notes WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap()
        };

        store
            .set_note_kind(
                id,
                "daily",
                &NoteKind::Essay { title: String::new(), status: EssayStatus::Writing },
            )
            .unwrap()
            .unwrap();
        assert_eq!(raw_status(&store).as_deref(), Some("writing"), "essay 化は明示値を書く");

        // 手動 SQL で finished にした行も読める（⌃Q が来る Phase 2 までの運用経路）
        store
            .conn()
            .execute("UPDATE notes SET status = 'finished' WHERE id = ?1", params![id])
            .unwrap();
        let read = store.get_note(id).unwrap().unwrap();
        assert_eq!(
            read.kind,
            NoteKind::Essay { title: String::new(), status: EssayStatus::Finished }
        );

        // NULL = writing（v42 直後の既存 essay）
        store.conn().execute("UPDATE notes SET status = NULL WHERE id = ?1", params![id]).unwrap();
        let read = store.get_note(id).unwrap().unwrap();
        assert_eq!(
            read.kind,
            NoteKind::Essay { title: String::new(), status: EssayStatus::Writing }
        );

        // essay → daily で status 列も NULL に戻る
        store
            .conn()
            .execute("UPDATE notes SET status = 'finished' WHERE id = ?1", params![id])
            .unwrap();
        store.set_note_kind(id, "essay", &NoteKind::Daily).unwrap().unwrap();
        assert_eq!(raw_status(&store), None, "daily 化で status 列も NULL に戻る");

        // 未知の status は読み取りで Err（typo を既定に隠さない）
        store
            .conn()
            .execute("UPDATE notes SET kind = 'essay', status = 'bogus' WHERE id = ?1", params![id])
            .unwrap();
        assert!(store.get_note(id).is_err());
    }

    #[test]
    fn project_title_round_trips_via_title_column() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        seed_project(&store, "o/r");
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();
        store
            .set_note_kind(
                id,
                "daily",
                &NoteKind::Project { project_id: "o/r".to_string(), title: "knowledge".to_string() },
            )
            .unwrap()
            .unwrap();

        let title: Option<String> = store
            .conn()
            .query_row("SELECT title FROM notes WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(title.as_deref(), Some("knowledge"), "project title は essay と同じ title 列");
        let read = store.get_note(id).unwrap().unwrap();
        assert_eq!(
            read.kind,
            NoteKind::Project { project_id: "o/r".to_string(), title: "knowledge".to_string() }
        );
    }

    #[test]
    fn daily_counts_kind_filter() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.create_note(0).unwrap();
        store
            .set_note_kind(
                "note-2",
                "daily",
                &NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing },
            )
            .unwrap()
            .unwrap();
        set_date(&store, "note-1", "2026-07-10");
        set_date(&store, "note-2", "2026-07-11");

        let all = store.daily_note_counts(None, None, None).unwrap();
        assert_eq!(all.len(), 2, "kind なしは従来どおり全 kind を数える");
        let daily_only = store.daily_note_counts(None, None, Some("daily")).unwrap();
        assert_eq!(
            daily_only,
            vec![DailyNoteCount { date: "2026-07-10".to_string(), count: 1 }],
            "kind='daily' で essay の日が消える"
        );
    }

    #[test]
    fn kind_from_columns_covers_all_shapes() {
        assert_eq!(
            kind_from_columns("project", None, Some("o/r".to_string()), None).unwrap(),
            NoteKind::Project { project_id: "o/r".to_string(), title: String::new() }
        );
        assert_eq!(
            kind_from_columns("project", Some("named".to_string()), Some("o/r".to_string()), None)
                .unwrap(),
            NoteKind::Project { project_id: "o/r".to_string(), title: "named".to_string() }
        );
        assert_eq!(kind_from_columns("project", None, None, None).unwrap(), NoteKind::Daily);
        assert_eq!(kind_from_columns("daily", None, None, None).unwrap(), NoteKind::Daily);
        assert_eq!(
            kind_from_columns("essay", Some("t".to_string()), None, None).unwrap(),
            NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing },
            "NULL status は writing として読む（v42 は backfill しない）"
        );
        assert_eq!(
            kind_from_columns("essay", None, None, Some("finished".to_string())).unwrap(),
            NoteKind::Essay { title: String::new(), status: EssayStatus::Finished },
            "NULL title は無題として読む"
        );
        assert!(
            kind_from_columns("essay", None, None, Some("drafting".to_string())).is_err(),
            "未知の status は既定に倒さず Err"
        );
        assert!(
            kind_from_columns("memo", None, None, None).is_err(),
            "v40 後に旧 kind は存在しない"
        );
    }

    #[test]
    fn get_note_block_resolves_and_misses() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let note = store.create_note(0).unwrap();
        let id = note.id.as_str();
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","attrs":{"id":"blk"},"content":[
                {"type":"paragraph","content":[{"type":"text","text":"body"}]}]}]}]}"#;
        store
            .update_note(id, UpdateNote { title: None, content: RawJson::from(doc) })
            .unwrap();

        let sub = store.get_note_block(id, "blk").unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(sub.as_str()).unwrap();
        assert_eq!(value["attrs"]["id"], "blk");

        assert!(store.get_note_block(id, "nope").unwrap().is_none(), "block 不在は None");
        assert!(store.get_note_block("note-999", "blk").unwrap().is_none(), "note 不在は None");

        store.delete_note(id).unwrap();
        assert!(store.get_note_block(id, "blk").unwrap().is_none(), "soft-delete 後は None");
    }

    fn search_ids(store: &SqliteStore, q: &str) -> Vec<String> {
        store.search_notes(q, 10).unwrap().into_iter().map(|s| s.id.into_string()).collect()
    }

    #[test]
    fn search_ignores_schema_vocabulary() {
        // 受け入れ条件の本丸: "paragraph" は全 note の doc JSON に構造語として現れるが、
        // FTS body は plain_text 投影なのでヒットしない。本文に literal で持つ note だけ当たる。
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.create_note(0).unwrap();
        store.update_note("note-2", content_update("a paragraph structure here")).unwrap();

        assert_eq!(search_ids(&store, "paragraph"), vec!["note-2"], "schema 語彙に偽陽性なし");
    }

    #[test]
    fn search_two_char_cjk_hits_body_via_like() {
        // 2 codepoint（trigram 不能）は body LIKE で拾う。byte 長判定だと静かに 0 件になる回帰。
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.update_note("note-1", content_update("これは設計の話")).unwrap();

        assert_eq!(search_ids(&store, "設計"), vec!["note-1"]);
    }

    #[test]
    fn search_matches_visible_atom_titles() {
        // 生 content LIKE で拾えていた bookmark/linkMention の title を FTS でも拾う。
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[
                {"type":"bookmark","attrs":{"href":"https://x.test","title":"Quarterly Roadmap"}}]}]}]}"#;
        store.update_note("note-1", UpdateNote { title: None, content: RawJson::from(doc) }).unwrap();

        assert_eq!(search_ids(&store, "Quarterly"), vec!["note-1"], "bookmark title searchable");
    }

    #[test]
    fn search_escapes_like_wildcards_in_short_queries() {
        // 1-2 codepoint は body LIKE 分岐。full-text search は facade で再フィルタしないので、
        // `_` をエスケープしないと non-empty body 全件に化ける。
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.create_note(0).unwrap();
        store.update_note("note-1", content_update("a_b literal underscore")).unwrap();
        store.update_note("note-2", content_update("axb no wildcard")).unwrap();

        assert_eq!(search_ids(&store, "_"), vec!["note-1"], "literal underscore only");
    }

    #[test]
    fn search_three_char_cjk_hits_body_via_match() {
        // 3 codepoint（9 bytes）は MATCH 分岐。マルチバイト境界で MATCH が本文に当たる。
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.update_note("note-1", content_update("設計図の一覧")).unwrap();

        assert_eq!(search_ids(&store, "設計図"), vec!["note-1"]);
    }

    #[test]
    fn search_reindexes_on_update() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.update_note("note-1", content_update("alpha content")).unwrap();
        assert_eq!(search_ids(&store, "alpha"), vec!["note-1"]);

        store.update_note("note-1", content_update("bravo content")).unwrap();
        assert!(search_ids(&store, "alpha").is_empty(), "旧本文でヒットしない");
        assert_eq!(search_ids(&store, "bravo"), vec!["note-1"], "新本文でヒットする");
    }

    #[test]
    fn search_query_with_fts_operators_does_not_error() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        // MATCH に渡す前に phrase エスケープするので、演算子入りでも構文エラーにならない。
        for q in ["a\"b\"c", "foo OR bar", "wild* card", "-nope", "AND NOT"] {
            assert!(store.search_notes(q, 10).is_ok(), "query {q:?} must not error");
        }
    }

    #[test]
    fn search_excludes_soft_deleted_and_restores() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.create_note(0).unwrap();
        store.update_note("note-1", content_update("findme text")).unwrap();
        assert_eq!(search_ids(&store, "findme"), vec!["note-1"]);

        store.delete_note("note-1").unwrap();
        assert!(search_ids(&store, "findme").is_empty(), "soft-delete でヒットしない");

        store.restore_note("note-1").unwrap();
        assert_eq!(search_ids(&store, "findme"), vec!["note-1"], "restore で復活（FTS 行温存）");
    }

    #[test]
    fn backfill_indexes_pre_v41_rows() {
        use crate::migrations::test_support::{stage_through, temp_db_path};

        // v41 以前（notes_fts が無い時点）の DB に raw の notes 行を仕込む。
        let path = temp_db_path("notes-fts-backfill");
        {
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            stage_through(&mut conn, 40);
            conn.execute(
                "INSERT INTO notes (id, kind, content, date) VALUES ('note-1', 'daily', ?1, '2026-07-19')",
                params![doc_with_text("legacy body")],
            )
            .unwrap();
        }

        // open で migrate（v41）+ backfill が走り、既存行が索引される。
        let store = SqliteStore::open_at(&path).unwrap();
        assert_eq!(search_ids(&store, "legacy"), vec!["note-1"]);

        // 二度目の open は no-op（索引済み）で壊れない。
        let store2 = SqliteStore::open_at(&path).unwrap();
        assert_eq!(search_ids(&store2, "legacy"), vec!["note-1"]);
    }

    #[test]
    fn concurrent_open_backfills_once() {
        use crate::migrations::test_support::{stage_through, temp_db_path};

        let path = temp_db_path("notes-fts-concurrent");
        {
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            stage_through(&mut conn, 40);
            conn.execute(
                "INSERT INTO notes (id, kind, content, date) VALUES ('note-1', 'daily', ?1, '2026-07-19')",
                params![doc_with_text("shared body")],
            )
            .unwrap();
        }

        // 2 コネクションで開いても Immediate tx ゲートで二重 backfill にならない（両方成功）。
        let a = SqliteStore::open_at(&path).unwrap();
        let b = SqliteStore::open_at(&path).unwrap();
        assert_eq!(search_ids(&a, "shared"), vec!["note-1"]);
        assert_eq!(search_ids(&b, "shared"), vec!["note-1"]);

        // 索引は 1 セットだけ（rowid 重複していない）。
        let rows: i64 =
            a.conn().query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
    }
}
