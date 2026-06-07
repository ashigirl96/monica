use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::sqlite::SqliteStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalTabRow {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub sort_order: i64,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalWorkspaceRow {
    pub id: String,
    pub sort_order: i64,
    pub is_active: bool,
    pub tabs: Vec<TerminalTabRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStateSnapshot {
    pub workspaces: Vec<TerminalWorkspaceRow>,
}

impl SqliteStore {
    pub fn load_terminal_state(&self) -> Result<TerminalStateSnapshot> {
        let mut ws_stmt = self.conn().prepare(
            "SELECT id, sort_order, is_active FROM terminal_workspaces ORDER BY sort_order",
        )?;

        let mut tab_stmt = self.conn().prepare(
            "SELECT id, cwd, title, sort_order, is_active
               FROM terminal_tabs
              WHERE workspace_id = ?1
              ORDER BY sort_order",
        )?;

        let workspaces = ws_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut result = Vec::with_capacity(workspaces.len());
        for (ws_id, sort_order, is_active) in workspaces {
            let tabs = tab_stmt
                .query_map(params![ws_id], |row| {
                    Ok(TerminalTabRow {
                        id: row.get(0)?,
                        cwd: row.get(1)?,
                        title: row.get(2)?,
                        sort_order: row.get(3)?,
                        is_active: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;

            result.push(TerminalWorkspaceRow {
                id: ws_id,
                sort_order,
                is_active,
                tabs,
            });
        }

        Ok(TerminalStateSnapshot {
            workspaces: result,
        })
    }

    pub fn save_terminal_state(&mut self, snapshot: &TerminalStateSnapshot) -> Result<()> {
        let tx = self.conn.transaction()?;

        tx.execute("DELETE FROM terminal_tabs", [])?;
        tx.execute("DELETE FROM terminal_workspaces", [])?;

        for ws in &snapshot.workspaces {
            tx.execute(
                "INSERT INTO terminal_workspaces (id, sort_order, is_active)
                 VALUES (?1, ?2, ?3)",
                params![ws.id, ws.sort_order, ws.is_active],
            )?;

            for tab in &ws.tabs {
                tx.execute(
                    "INSERT INTO terminal_tabs (id, workspace_id, cwd, title, sort_order, is_active)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![tab.id, ws.id, tab.cwd, tab.title, tab.sort_order, tab.is_active],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }
}
