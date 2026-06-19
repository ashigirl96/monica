use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::filesystem::paths;

mod migrations;
mod row;
mod store;
#[cfg(test)]
mod tests;

pub use store::terminal::{TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow};

/// A handle to Monica's SQLite store. Opening always runs pending migrations.
pub struct SqliteStore {
    conn: Connection,
    attachment_base_dir: Option<PathBuf>,
}

pub type Db = SqliteStore;

impl SqliteStore {
    /// Open the on-disk database at the resolved path (`$MONICA_HOME/db/monica.db`),
    /// creating the parent directory if needed.
    pub fn open() -> Result<Self> {
        let base_dir = paths::base_dir()?;
        let path = base_dir.join("db").join("monica.db");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("failed to open database at {}", path.display()))?;
        Self::init(conn, Some(base_dir))
    }

    pub fn open_at(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let attachment_base_dir = attachment_base_dir_from_db_path(path);
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open database at {}", path.display()))?;
        Self::init(conn, attachment_base_dir)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(mut conn: Connection, attachment_base_dir: Option<PathBuf>) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        // Every hook event runs in its own `monica hook claude` process while the app polls and
        // writes concurrently; without a timeout a colliding write fails hard with SQLITE_BUSY
        // and the observation (e.g. a side run's SessionEnd) is lost.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        self::migrations::migrate(&mut conn)?;
        Ok(Self {
            conn,
            attachment_base_dir,
        })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub(crate) fn attachment_base_dir(&self) -> Option<&Path> {
        self.attachment_base_dir.as_deref()
    }
}

fn attachment_base_dir_from_db_path(path: &Path) -> Option<PathBuf> {
    let db_dir = path.parent()?;
    if db_dir.file_name()? != "db" {
        return None;
    }
    db_dir.parent().map(Path::to_path_buf)
}
