pub(super) const SQL: &str = r#"
CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT,
  task_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::test_support::{assert_column_exists, assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn v29_creates_notification_outbox() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 28);
        conn.execute_batch(SQL).unwrap();
        assert_table_exists(&conn, "notification_outbox");
        assert_column_exists(&conn, "notification_outbox", "dedupe_key");
        assert_column_exists(&conn, "notification_outbox", "kind");
        assert_column_exists(&conn, "notification_outbox", "delivered_at");
        assert_column_exists(&conn, "notification_outbox", "attempts");
    }
}
