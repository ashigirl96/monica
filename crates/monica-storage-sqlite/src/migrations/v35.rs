/// v35: persist generated explanations and the agent/terminal sessions that authored them.
pub(super) const SQL: &str = r#"
    CREATE TABLE explanation_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE explanations (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL CHECK (trim(title) <> ''),
      mode                  TEXT NOT NULL CHECK (mode IN ('topic', 'diff')),
      artifact_path         TEXT NOT NULL UNIQUE,
      provider_session_id   TEXT NOT NULL CHECK (trim(provider_session_id) <> ''),
      terminal_session_id   TEXT NOT NULL CHECK (trim(terminal_session_id) <> ''),
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX explanations_created_at_idx ON explanations(created_at DESC);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_index_exists, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn creates_explanation_tables_and_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 34);
        conn.execute_batch(super::SQL).unwrap();

        for table in ["explanation_counter", "explanations"] {
            assert_table_exists(&conn, table);
        }
        assert_index_exists(&conn, "explanations_created_at_idx");
    }
}
