use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::sqlite::SqliteStore;
use monica_application::{Clock, Event, EventRepository};

use super::{EVENT_COLUMNS, SET_NOW};

impl EventRepository for SqliteStore {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        self.conn().execute(
            "INSERT INTO events (task_id, task_run_id, kind, payload_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![task_id, task_run_id, kind, payload_json],
        )?;
        let id = self.conn().last_insert_rowid();
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1"))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => crate::sqlite::row::event_from_row(row),
            None => Err(anyhow!("inserted event {id} not found")),
        }
    }

    /// List events, optionally filtered to one task. Ordered by insertion (`id`).
    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM events
             WHERE (?1 IS NULL OR task_id = ?1)
             ORDER BY id"
        ))?;
        let mut rows = stmt.query(params![task_id])?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            events.push(crate::sqlite::row::event_from_row(row)?);
        }
        Ok(events)
    }
}

impl Clock for SqliteStore {
    /// Current UTC timestamp in the same ISO-8601 form the schema's column defaults use. Lets
    /// non-DB run outputs (e.g. `hook-events.jsonl`) share one timestamp format without pulling in a
    /// date/time crate.
    fn now_iso(&self) -> Result<String> {
        let ts: String = self
            .conn()
            .query_row(&format!("SELECT {SET_NOW}"), [], |r| r.get(0))?;
        Ok(ts)
    }
}
