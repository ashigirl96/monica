use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::{migrations, paths};

/// A handle to Monica's SQLite store. Opening always runs pending migrations.
pub struct Db {
    conn: Connection,
}

impl Db {
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

    pub fn open_at(path: impl AsRef<Path>) -> Result<Self> {
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
        migrations::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}
