/// v27: retain the Claude plan file a run is waiting on. The `ExitPlanMode` PreToolUse payload
/// carries `tool_input.planFilePath` (e.g. `~/.claude/plans/hazy-wiggling-salamander.md`), but it
/// only lives in the wholesale-overwritten `metadata_json`, so the next hook erases it. This column
/// keeps the most recent plan path, set on the ExitPlanMode observation and left untouched by
/// later hooks.
///
/// The backfill recovers only runs still parked on a plan (`wait_reason = 'exit_plan_mode'`): those
/// are the only ones whose `metadata_json` still holds the ExitPlanMode payload, since a run that
/// moved past plan mode had it overwritten by the next hook. Scoping by wait_reason both avoids
/// re-deriving a stale path for runs that already approved and skips runs where the source is gone.
/// `json_valid` guards against a (manually) corrupted row aborting the whole migration on startup.
pub(super) const SQL: &str = r#"
    ALTER TABLE task_runs ADD COLUMN plan_file_path TEXT;

    UPDATE task_runs
       SET plan_file_path = json_extract(metadata_json, '$.tool_input.planFilePath')
     WHERE wait_reason = 'exit_plan_mode'
       AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.tool_name') = 'ExitPlanMode';
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{assert_column_exists, stage_through};
    use rusqlite::Connection;

    fn plan_file_path(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT plan_file_path FROM task_runs WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn adds_column_and_backfills_only_runs_parked_on_a_plan() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 26);
        conn.execute_batch(
            r#"
            INSERT INTO tasks (id, kind, status, title) VALUES ('MON-1', 'dev', 'in_progress', 't');
            INSERT INTO task_runs (id, task_id, status, wait_reason, metadata_json) VALUES
                ('run-waiting', 'MON-1', 'waiting_for_user', 'exit_plan_mode',
                 '{"tool_name":"ExitPlanMode","tool_input":{"planFilePath":"/plans/hazy.md"}}'),
                ('run-approved', 'MON-1', 'running', NULL,
                 '{"tool_name":"ExitPlanMode","tool_input":{"planFilePath":"/plans/stale.md"}}'),
                ('run-other', 'MON-1', 'running', NULL, '{"tool_name":"Read"}'),
                ('run-corrupt', 'MON-1', 'waiting_for_user', 'exit_plan_mode', 'not json');
            "#,
        )
        .unwrap();

        // A single malformed-JSON row must not abort the migration on startup.
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "task_runs", "plan_file_path");

        // Parked on a plan: backfilled.
        assert_eq!(plan_file_path(&conn, "run-waiting").as_deref(), Some("/plans/hazy.md"));
        // Already moved past plan mode (wait_reason cleared): not re-derived from stale metadata.
        assert_eq!(plan_file_path(&conn, "run-approved"), None);
        // Never had a plan.
        assert_eq!(plan_file_path(&conn, "run-other"), None);
        // Corrupt metadata is skipped, not fatal.
        assert_eq!(plan_file_path(&conn, "run-corrupt"), None);
    }
}
