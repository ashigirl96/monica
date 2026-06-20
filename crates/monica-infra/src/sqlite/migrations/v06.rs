/// v6: make Task status product-level only, collapse AgentSession observation fields into
/// TaskRun, add waiting-for-user run state, and replace archived with soft deletion.
pub(super) const SQL: &str = r#"
    ALTER TABLE tasks ADD COLUMN deleted_at TEXT;

    ALTER TABLE task_runs ADD COLUMN wait_reason TEXT;
    ALTER TABLE task_runs ADD COLUMN provider_session_id TEXT;
    ALTER TABLE task_runs ADD COLUMN last_event_name TEXT;
    ALTER TABLE task_runs ADD COLUMN last_event_at TEXT;
    ALTER TABLE task_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

    UPDATE task_runs
       SET provider_session_id = (
             SELECT s.provider_session_id
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ),
           last_event_name = (
             SELECT s.last_event_name
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ),
           last_event_at = (
             SELECT s.last_event_at
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ),
           metadata_json = COALESCE((
             SELECT s.metadata_json
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
              ORDER BY s.updated_at DESC,
                       CAST(SUBSTR(s.id, 9) AS INTEGER) DESC
              LIMIT 1
           ), metadata_json)
     WHERE EXISTS (
             SELECT 1
               FROM agent_sessions s
              WHERE s.task_run_id = task_runs.id
           );

    INSERT INTO task_runs (id, task_id, status, wait_reason, created_at, updated_at)
    SELECT 'legacy-' || t.id,
           t.id,
           CASE
             WHEN t.status = 'need_approval' THEN 'waiting_for_user'
             ELSE 'failed'
           END,
           CASE
             WHEN t.status = 'need_approval' THEN 'exit_plan_mode'
             ELSE NULL
           END,
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM tasks t
     WHERE t.status IN ('need_approval', 'failed')
       AND NOT EXISTS (
             SELECT 1
               FROM task_runs r
              WHERE r.task_id = t.id
           );

    UPDATE task_runs
       SET status = 'waiting_for_user',
           wait_reason = 'exit_plan_mode',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id IN (
       SELECT latest.id
         FROM tasks t
         JOIN task_runs latest
           ON latest.id = (
             SELECT r.id
               FROM task_runs r
              WHERE r.task_id = t.id
              ORDER BY r.created_at DESC,
                       CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
              LIMIT 1
           )
        WHERE t.status = 'need_approval'
     );

    UPDATE task_runs
       SET status = 'failed',
           wait_reason = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id IN (
       SELECT latest.id
         FROM tasks t
         JOIN task_runs latest
           ON latest.id = (
             SELECT r.id
               FROM task_runs r
              WHERE r.task_id = t.id
              ORDER BY r.created_at DESC,
                       CASE
                         WHEN r.id GLOB 'run-[0-9]*' THEN CAST(SUBSTR(r.id, 5) AS INTEGER)
                         ELSE -1
                       END DESC,
                       r.id DESC
              LIMIT 1
           )
        WHERE t.status = 'failed'
     );

    UPDATE tasks
       SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status = 'archived'
       AND deleted_at IS NULL;

    UPDATE tasks
       SET status = CASE
         WHEN status = 'inbox' THEN 'inbox'
         WHEN status = 'ready' THEN 'ready'
         WHEN status = 'done' THEN 'done'
         ELSE 'in_progress'
       END
     WHERE status IN (
       'active',
       'need_approval',
       'failed',
       'pr_open',
       'archived',
       'setting_up',
       'running',
       'stopped'
     );

    DROP TABLE agent_sessions;
    DROP TABLE agent_session_counter;
"#;

#[cfg(test)]
mod tests {
    use crate::sqlite::migrations::test_support::{
        assert_column_exists, assert_table_absent, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn adds_deleted_at_and_drops_agent_sessions() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 5);
        conn.execute_batch(super::SQL).unwrap();
        assert_column_exists(&conn, "tasks", "deleted_at");
        assert_table_absent(&conn, "agent_sessions");
    }
}
