/// v45: drop the PR-sync scheduler state. The periodic worker and its retry/backoff machinery
/// were removed in favor of forced-only bulk refresh, so `github_pull_request_branch_syncs` has
/// no readers left, and the scheduling columns of `github_pull_request_ref_states` (synced_at is
/// always equal to updated_at on the sole remaining write path) are dead. The index must go
/// first: SQLite refuses to drop an indexed column, and the remaining reader joins by primary
/// key only.
pub(super) const SQL: &str = r#"
    DROP TABLE github_pull_request_branch_syncs;
    DROP INDEX github_pr_ref_states_refresh_idx;
    ALTER TABLE github_pull_request_ref_states DROP COLUMN synced_at;
    ALTER TABLE github_pull_request_ref_states DROP COLUMN last_error;
    ALTER TABLE github_pull_request_ref_states DROP COLUMN next_retry_at;
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_absent, assert_column_exists, assert_table_absent, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn drops_pr_sync_scheduler_state() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 44);
        conn.execute_batch(super::SQL).unwrap();
        assert_table_absent(&conn, "github_pull_request_branch_syncs");
        for column in ["synced_at", "last_error", "next_retry_at"] {
            assert_column_absent(&conn, "github_pull_request_ref_states", column);
        }
        for column in ["external_ref_id", "status", "created_at", "updated_at"] {
            assert_column_exists(&conn, "github_pull_request_ref_states", column);
        }
    }
}
