/// v18: drop external_ref_syncs; PR sync state lives in github_pull_request_ref_states (v8)
/// and github_pull_request_branch_syncs (v9), and nothing ever read this table back.
pub(super) const SQL: &str = r#"
    DROP TABLE external_ref_syncs;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{assert_table_absent, stage_through};
    use rusqlite::Connection;

    #[test]
    fn drops_external_ref_syncs() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 17);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_absent(&conn, "external_ref_syncs");
    }
}
