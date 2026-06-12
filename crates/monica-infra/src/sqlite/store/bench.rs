use anyhow::Result;
use rusqlite::params;

use crate::sqlite::SqliteStore;
use monica_core::BenchRepository;

impl BenchRepository for SqliteStore {
    fn get_bench_for_task(&self, task_id: &str) -> Result<Option<(String, String)>> {
        let mut stmt = self.conn().prepare(
            "SELECT runspace_id, cwd FROM \"_TaskToRunspace\" WHERE task_id = ?1",
        )?;
        let mut rows = stmt.query(params![task_id])?;
        match rows.next()? {
            Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
            None => Ok(None),
        }
    }

    fn list_bench_runspace_map(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn().prepare(
            "SELECT runspace_id, task_id FROM \"_TaskToRunspace\"",
        )?;
        let mut rows = stmt.query([])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push((row.get(0)?, row.get(1)?));
        }
        Ok(items)
    }

    fn create_bench(&mut self, task_id: &str, runspace_id: &str, cwd: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO \"_TaskToRunspace\" (task_id, runspace_id, cwd) VALUES (?1, ?2, ?3)",
            params![task_id, runspace_id, cwd],
        )?;
        Ok(())
    }

    fn update_bench_cwd(&self, task_id: &str, cwd: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE \"_TaskToRunspace\" SET cwd = ?1 WHERE task_id = ?2",
            params![cwd, task_id],
        )?;
        Ok(())
    }
}
