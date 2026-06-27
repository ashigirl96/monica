use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};

use crate::SqliteStore;
use monica_application::{Clock, Event, EventRepository};

use super::{EVENT_COLUMNS, SET_NOW};

pub(crate) fn insert_event_in(
    conn: &Connection,
    task_id: Option<&str>,
    task_run_id: Option<&str>,
    kind: &str,
    payload_json: &str,
) -> Result<Event> {
    conn.execute(
        "INSERT INTO events (task_id, task_run_id, kind, payload_json)
         VALUES (?1, ?2, ?3, ?4)",
        params![task_id, task_run_id, kind, payload_json],
    )?;
    let id = conn.last_insert_rowid();
    let mut stmt = conn.prepare(&format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => crate::row::event_from_row(row),
        None => Err(anyhow!("inserted event {id} not found")),
    }
}

pub(crate) fn list_events_in(conn: &Connection, task_id: Option<&str>) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EVENT_COLUMNS} FROM events
         WHERE (?1 IS NULL OR task_id = ?1)
         ORDER BY id"
    ))?;
    let mut rows = stmt.query(params![task_id])?;
    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        events.push(crate::row::event_from_row(row)?);
    }
    Ok(events)
}

pub(crate) fn now_iso_in(conn: &Connection) -> Result<String> {
    let ts: String = conn.query_row(&format!("SELECT {SET_NOW}"), [], |r| r.get(0))?;
    Ok(ts)
}

impl EventRepository for SqliteStore {
    fn insert_event(
        &self,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        kind: &str,
        payload_json: &str,
    ) -> Result<Event> {
        insert_event_in(self.conn(), task_id, task_run_id, kind, payload_json)
    }

    fn list_events(&self, task_id: Option<&str>) -> Result<Vec<Event>> {
        list_events_in(self.conn(), task_id)
    }
}

impl Clock for SqliteStore {
    fn now_iso(&self) -> Result<String> {
        now_iso_in(self.conn())
    }
}
