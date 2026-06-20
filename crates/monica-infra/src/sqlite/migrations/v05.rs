/// v5: rename the internal domain from WorkItem/Run to Task/TaskRun, split task state from run
/// state, and add minimal agent-session persistence. Existing MON ids and run-<n> ids stay stable.
pub(super) const SQL: &str = r#"
    ALTER TABLE work_items RENAME TO tasks;
    ALTER TABLE runs RENAME TO task_runs;
    ALTER TABLE run_counter RENAME TO task_run_counter;

    ALTER TABLE task_runs RENAME COLUMN work_item_id TO task_id;
    ALTER TABLE events RENAME COLUMN work_item_id TO task_id;
    ALTER TABLE events RENAME COLUMN run_id TO task_run_id;
    ALTER TABLE external_refs RENAME COLUMN work_item_id TO task_id;

    INSERT INTO task_runs (id, task_id, status, created_at, updated_at)
    SELECT 'legacy-' || t.id,
           t.id,
           t.status,
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM tasks t
     WHERE t.status IN ('setting_up', 'running', 'stopped')
       AND (
             NOT EXISTS (
               SELECT 1
                 FROM task_runs r
                WHERE r.task_id = t.id
             )
             OR (
               SELECT r.status
                 FROM task_runs r
                WHERE r.task_id = t.id
                ORDER BY r.created_at DESC,
                         CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
                LIMIT 1
             ) != t.status
           );

    UPDATE tasks
       SET status = 'active'
     WHERE status IN ('setting_up', 'running', 'stopped');

    CREATE TABLE agent_session_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);

    CREATE TABLE agent_sessions (
      id                  TEXT PRIMARY KEY,
      task_id             TEXT NOT NULL REFERENCES tasks(id),
      task_run_id         TEXT NOT NULL REFERENCES task_runs(id),
      agent               TEXT NOT NULL,
      mode                TEXT NOT NULL,
      status              TEXT NOT NULL,
      provider_session_id TEXT,
      parent_session_id   TEXT,
      last_event_name     TEXT,
      last_event_at       TEXT,
      metadata_json       TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn renames_to_task_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 4);
        conn.execute_batch(super::SQL).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        for expected in ["tasks", "task_runs", "task_run_counter"] {
            assert!(tables.contains(&expected.to_string()), "missing table: {expected}");
        }
        for gone in ["work_items", "runs", "run_counter"] {
            assert!(!tables.contains(&gone.to_string()), "table should be renamed: {gone}");
        }
    }
}
