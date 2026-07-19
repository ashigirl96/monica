// notes 本文の FTS5 全文索引。索引する plain text（`monica_domain::plain_text`）は Rust だけが
// 導出するため、既存行の backfill は migration ではなく `SqliteStore::init` が担う（frozen な
// migration に walker ロジックを複製しない）。rowid は note id の数値サフィックスをそのまま使う。
// trigram tokenizer は日本語を含む 3 文字以上の substring 検索を可能にする（unicode61 では
// CJK が実質検索不能）。
pub(super) const SQL: &str = r#"
    CREATE VIRTUAL TABLE notes_fts USING fts5(
        body,
        note_id UNINDEXED,
        tokenize = 'trigram'
    );
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn creates_notes_fts_and_matches() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 40);

        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "notes_fts");

        conn.execute(
            "INSERT INTO notes_fts (rowid, body, note_id) VALUES (1, 'hello world', 'note-1')",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH ?1",
                ["\"hello\""],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
