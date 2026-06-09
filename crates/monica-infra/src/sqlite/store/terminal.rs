use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::sqlite::SqliteStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TerminalTabRow {
    pub id: String,
    pub kind: String,
    pub task_run_id: Option<String>,
    pub setup_log_path: Option<String>,
    pub cwd: String,
    pub title: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub sort_order: i64,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TerminalRunspaceRow {
    pub id: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub sort_order: i64,
    pub is_active: bool,
    pub tabs: Vec<TerminalTabRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TerminalStateSnapshot {
    pub runspaces: Vec<TerminalRunspaceRow>,
}

impl SqliteStore {
    pub fn load_terminal_state(&self) -> Result<TerminalStateSnapshot> {
        let mut rs_stmt = self.conn().prepare(
            "SELECT id, sort_order, is_active FROM terminal_runspaces ORDER BY sort_order",
        )?;

        let mut tab_stmt = self.conn().prepare(
            "SELECT id, kind, task_run_id, setup_log_path, cwd, title, sort_order, is_active
               FROM terminal_tabs
              WHERE runspace_id = ?1
              ORDER BY sort_order",
        )?;

        let runspaces = rs_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut result = Vec::with_capacity(runspaces.len());
        for (rs_id, sort_order, is_active) in runspaces {
            let tabs = tab_stmt
                .query_map(params![rs_id], |row| {
                    Ok(TerminalTabRow {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        task_run_id: row.get(2)?,
                        setup_log_path: row.get(3)?,
                        cwd: row.get(4)?,
                        title: row.get(5)?,
                        sort_order: row.get(6)?,
                        is_active: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;

            result.push(TerminalRunspaceRow {
                id: rs_id,
                sort_order,
                is_active,
                tabs,
            });
        }

        Ok(TerminalStateSnapshot { runspaces: result })
    }

    pub fn save_terminal_state(&mut self, snapshot: &TerminalStateSnapshot) -> Result<()> {
        let tx = self.conn.transaction()?;

        tx.execute("DELETE FROM terminal_tabs", [])?;
        tx.execute("DELETE FROM terminal_runspaces", [])?;

        for rs in &snapshot.runspaces {
            tx.execute(
                "INSERT INTO terminal_runspaces (id, sort_order, is_active)
                 VALUES (?1, ?2, ?3)",
                params![rs.id, rs.sort_order, rs.is_active],
            )?;

            for tab in &rs.tabs {
                tx.execute(
                    "INSERT INTO terminal_tabs
                       (id, runspace_id, kind, task_run_id, setup_log_path, cwd, title, sort_order, is_active)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        tab.id,
                        rs.id,
                        tab.kind,
                        tab.task_run_id,
                        tab.setup_log_path,
                        tab.cwd,
                        tab.title,
                        tab.sort_order,
                        tab.is_active
                    ],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }
}
