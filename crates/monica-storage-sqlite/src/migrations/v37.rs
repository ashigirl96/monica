pub(super) const SQL: &str = r#"
    ALTER TABLE explanations ADD COLUMN repo_name TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_repo_name_column_to_explanations() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 36);
        conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        conn.execute(
            "INSERT INTO explanation_counter DEFAULT VALUES",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO explanations (id, title, mode, provider_session_id, terminal_session_id)
             VALUES ('expl-1', 'existing', 'diff', 'p1', 'ts-fake')",
            [],
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "explanations", "repo_name");

        let repo_name: Option<String> = conn
            .query_row(
                "SELECT repo_name FROM explanations WHERE id = 'expl-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(repo_name.is_none());
    }
}
