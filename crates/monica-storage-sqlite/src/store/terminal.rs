use anyhow::Result;
use rusqlite::params;

use monica_application::{
    TerminalRunspaceKind, TerminalRunspaceRow, TerminalStateSnapshot, TerminalTabRow,
};

use crate::SqliteStore;

impl SqliteStore {
    pub fn load_terminal_state(&self, window_label: &str) -> Result<TerminalStateSnapshot> {
        let mut rs_stmt = self.conn().prepare(
            "SELECT id, sort_order FROM terminal_runspaces
              WHERE window_label = ?1
              ORDER BY sort_order",
        )?;

        let mut tab_stmt = self.conn().prepare(
            "SELECT id, cwd, title, sort_order, terminal_session_id
               FROM terminal_tabs
              WHERE runspace_id = ?1 AND window_label = ?2
              ORDER BY sort_order",
        )?;

        let runspaces = rs_stmt
            .query_map(params![window_label], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut result = Vec::with_capacity(runspaces.len());
        for (rs_id, sort_order) in runspaces {
            let tabs = tab_stmt
                .query_map(params![rs_id, window_label], |row| {
                    Ok(TerminalTabRow {
                        id: row.get(0)?,
                        cwd: row.get(1)?,
                        title: row.get(2)?,
                        sort_order: row.get(3)?,
                        terminal_session_id: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;

            result.push(TerminalRunspaceRow {
                kind: TerminalRunspaceKind::of_runspace_id(&rs_id),
                id: rs_id,
                sort_order,
                tabs,
            });
        }

        Ok(TerminalStateSnapshot {
            runspaces: result,
        })
    }

    pub fn save_terminal_state(
        &mut self,
        window_label: &str,
        snapshot: &TerminalStateSnapshot,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;

        tx.execute(
            "DELETE FROM terminal_tabs WHERE window_label = ?1",
            params![window_label],
        )?;
        tx.execute(
            "DELETE FROM terminal_runspaces WHERE window_label = ?1",
            params![window_label],
        )?;

        for rs in &snapshot.runspaces {
            tx.execute(
                "INSERT INTO terminal_runspaces (id, sort_order, window_label)
                 VALUES (?1, ?2, ?3)",
                params![rs.id, rs.sort_order, window_label],
            )?;

            for tab in &rs.tabs {
                tx.execute(
                    "INSERT INTO terminal_tabs
                       (id, runspace_id, window_label, cwd, title, sort_order, terminal_session_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        tab.id,
                        rs.id,
                        window_label,
                        tab.cwd,
                        tab.title,
                        tab.sort_order,
                        tab.terminal_session_id
                    ],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }
}
