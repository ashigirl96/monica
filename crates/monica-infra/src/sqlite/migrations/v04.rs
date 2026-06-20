/// v4: drop the per-project branch-name template. Branch names are now derived directly from the
/// run (`issue-<n>` for a linked GitHub issue, else `mon-<n>`), so the configurable rule is gone.
pub(super) const SQL: &str = r#"
    ALTER TABLE projects DROP COLUMN branch_template;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_column_absent, stage_through};
    use rusqlite::Connection;

    #[test]
    fn drops_branch_template_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 3);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_absent(&conn, "projects", "branch_template");
    }
}
