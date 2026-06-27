/// v3: run-id counter. Mirrors `mon_counter` so each run gets a monotonic `run-<n>` id that is
/// never reused, keeping the `runs/<task_run_id>/` run output directories collision-free.
pub(super) const SQL: &str = r#"
    CREATE TABLE run_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_table_exists, stage_through};
    use rusqlite::Connection;

    #[test]
    fn creates_run_counter_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 2);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_exists(&conn, "run_counter");
    }
}
