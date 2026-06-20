/// v19: retire the inbox status — tracking an issue creates tasks as ready, so inbox was an
/// unreachable parking lot. The enum variant is gone, so any surviving row must move or it
/// would fail to parse.
pub(super) const SQL: &str = r#"
    UPDATE tasks
       SET status = 'ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'inbox';
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn moves_inbox_to_ready() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 18);
        conn.execute_batch(
            "INSERT INTO tasks (id, kind, status, title) VALUES ('t1', 'dev', 'inbox', 'test')",
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        let status: String = conn
            .query_row("SELECT status FROM tasks WHERE id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "ready");
    }
}
