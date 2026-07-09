use anyhow::{Context, Result};
use rusqlite::Connection;

use monica_paths as paths;

mod migrations;
mod row;
mod store;
#[cfg(test)]
mod tests;


/// A handle to Monica's SQLite store. Opening always runs pending migrations.
pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    /// Open the on-disk database at the resolved path (`$MONICA_HOME/db/monica.db`),
    /// creating the parent directory if needed.
    pub fn open() -> Result<Self> {
        let path = paths::db_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("failed to open database at {}", path.display()))?;
        Self::init(conn)
    }

    pub fn open_at(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let path = path.as_ref();
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open database at {}", path.display()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        self::migrations::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

impl monica_application::NotificationOutboxStore for SqliteStore {
    fn enqueue_notification(
        &mut self,
        intent: monica_domain::NewNotificationIntent,
    ) -> Result<monica_domain::NotificationIntent> {
        store::notification_outbox::enqueue_notification_in(self.conn(), intent)
    }

    fn list_pending_notifications(
        &self,
        limit: usize,
    ) -> Result<Vec<monica_domain::NotificationIntent>> {
        store::notification_outbox::list_pending_notifications_in(self.conn(), limit)
    }

    fn mark_notification_delivered(&self, id: i64) -> Result<()> {
        store::notification_outbox::mark_notification_delivered_in(self.conn(), id)
    }

    fn mark_notification_failed(&self, id: i64, error: &str) -> Result<()> {
        store::notification_outbox::mark_notification_failed_in(self.conn(), id, error)
    }

    fn cancel_notifications_for_run(&self, task_run_id: &str) -> Result<()> {
        store::notification_outbox::cancel_notifications_for_run_in(self.conn(), task_run_id)
    }

    fn cancel_notification_by_dedupe_key(&self, dedupe_key: &str) -> Result<()> {
        store::notification_outbox::cancel_notification_by_dedupe_key_in(self.conn(), dedupe_key)
    }
}
