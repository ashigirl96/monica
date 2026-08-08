// pin の実体は runspace ↔ tab の 1:1。tab 側 bool だと複数 pinned tab の不正状態を
// 表現できてしまうため、runspace 側に tab id を 1 個持たせて構造で保証する。
// FK は張らない（terminal state は wholesale rewrite で、整合性は load 側が守る）。
pub(super) const SQL: &str = r#"
    ALTER TABLE terminal_runspaces ADD COLUMN pinned_tab_id TEXT;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn adds_pinned_tab_id_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 42);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "terminal_runspaces", "pinned_tab_id");
    }
}
