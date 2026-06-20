/// v4: drop the per-project branch-name template. Branch names are now derived directly from the
/// run (`issue-<n>` for a linked GitHub issue, else `mon-<n>`), so the configurable rule is gone.
pub(super) const SQL: &str = r#"
    ALTER TABLE projects DROP COLUMN branch_template;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn drops_branch_template_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 3);
        conn.execute_batch(super::SQL).unwrap();

        let has_column: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('projects') WHERE name = 'branch_template'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 0, "branch_template column must be dropped");
    }
}
