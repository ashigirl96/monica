/// v30: scope terminal runspaces AND tabs to a window label so each Tauri window persists its own
/// layout in isolation. The primary key of `terminal_runspaces` becomes `(window_label, id)` so
/// deterministic runspace IDs like `bench-{task_id}` can coexist across windows. `terminal_tabs`
/// gains the same `window_label` column to prevent cross-window tab leakage when runspace IDs
/// collide. The FK from terminal_tabs is dropped (consistent with v16's "reconcile owns
/// consistency" design).
pub(super) const SQL: &str = r#"
    CREATE TABLE terminal_runspaces_new (
      id           TEXT    NOT NULL,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      window_label TEXT    NOT NULL DEFAULT 'main',
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (window_label, id)
    );
    INSERT INTO terminal_runspaces_new (id, sort_order, created_at)
      SELECT id, sort_order, created_at FROM terminal_runspaces;

    CREATE TABLE terminal_tabs_new (
      id                  TEXT    PRIMARY KEY,
      runspace_id         TEXT    NOT NULL,
      window_label        TEXT    NOT NULL DEFAULT 'main',
      cwd                 TEXT    NOT NULL,
      title               TEXT    NOT NULL DEFAULT '',
      sort_order          INTEGER NOT NULL DEFAULT 0,
      terminal_session_id TEXT,
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO terminal_tabs_new
        (id, runspace_id, window_label, cwd, title, sort_order, terminal_session_id, created_at)
      SELECT id, runspace_id, 'main', cwd, title, sort_order, terminal_session_id, created_at
        FROM terminal_tabs;

    DROP TABLE terminal_tabs;
    DROP TABLE terminal_runspaces;
    ALTER TABLE terminal_runspaces_new RENAME TO terminal_runspaces;
    ALTER TABLE terminal_tabs_new RENAME TO terminal_tabs;
    CREATE INDEX terminal_tabs_runspace_idx
      ON terminal_tabs(window_label, runspace_id, sort_order);
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::{
        assert_column_exists, assert_index_exists, assert_table_exists, stage_through,
    };
    use rusqlite::Connection;

    #[test]
    fn rebuilds_with_composite_pk_and_preserves_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 29);

        conn.execute(
            "INSERT INTO terminal_runspaces (id, sort_order) VALUES ('rs-1', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO terminal_tabs (id, runspace_id, cwd, title, sort_order)
             VALUES ('tab-1', 'rs-1', '/tmp', 'tab', 0)",
            [],
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        assert_table_exists(&conn, "terminal_runspaces");
        assert_table_exists(&conn, "terminal_tabs");
        assert_column_exists(&conn, "terminal_runspaces", "window_label");
        assert_column_exists(&conn, "terminal_tabs", "window_label");
        assert_index_exists(&conn, "terminal_tabs_runspace_idx");

        let rs_label: String = conn
            .query_row(
                "SELECT window_label FROM terminal_runspaces WHERE id = 'rs-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rs_label, "main");

        let tab_label: String = conn
            .query_row(
                "SELECT window_label FROM terminal_tabs WHERE id = 'tab-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tab_label, "main");
    }

    #[test]
    fn allows_same_runspace_id_in_different_windows() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 29);
        conn.execute_batch(super::SQL).unwrap();

        conn.execute(
            "INSERT INTO terminal_runspaces (id, sort_order, window_label)
             VALUES ('bench-task-1', 0, 'main')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO terminal_runspaces (id, sort_order, window_label)
             VALUES ('bench-task-1', 0, 'monica-window-1')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO terminal_tabs (id, runspace_id, window_label, cwd, title, sort_order)
             VALUES ('tab-m', 'bench-task-1', 'main', '/home', 'main-tab', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO terminal_tabs (id, runspace_id, window_label, cwd, title, sort_order)
             VALUES ('tab-s', 'bench-task-1', 'monica-window-1', '/tmp', 'sec-tab', 0)",
            [],
        )
        .unwrap();

        let main_tabs: i64 = conn
            .query_row(
                "SELECT count(*) FROM terminal_tabs
                 WHERE runspace_id = 'bench-task-1' AND window_label = 'main'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(main_tabs, 1);

        let sec_tabs: i64 = conn
            .query_row(
                "SELECT count(*) FROM terminal_tabs
                 WHERE runspace_id = 'bench-task-1' AND window_label = 'monica-window-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sec_tabs, 1);
    }
}
