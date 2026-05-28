use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::db::Db;
use crate::model::{NewRun, Run, Status};

use super::{RUN_COLUMNS, SET_NOW};

impl Db {
    pub fn update_run_status(
        &self,
        run_id: &str,
        work_item_id: &str,
        status: Status,
    ) -> Result<()> {
        self.conn().execute(
            &format!(
                "UPDATE runs SET status = ?1, updated_at = {SET_NOW} \
                 WHERE id = ?2 AND work_item_id = ?3"
            ),
            params![status.as_str(), run_id, work_item_id],
        )?;
        Ok(())
    }

    /// Apply a hook-driven status to a work item, and — when `run_id` is given — to its run, in one
    /// transaction. The run update is additionally scoped by `work_item_id`, so a run that does not
    /// belong to this work item (e.g. a mismatched env var) is never touched even if the id exists.
    pub fn apply_hook_status(
        &mut self,
        work_item_id: &str,
        run_id: Option<&str>,
        status: Status,
    ) -> Result<()> {
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let affected = tx.execute(
            &format!("UPDATE work_items SET status = ?1, updated_at = {SET_NOW} WHERE id = ?2"),
            params![status, work_item_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("work item not found: {work_item_id}"));
        }
        if let Some(run_id) = run_id {
            tx.execute(
                &format!(
                    "UPDATE runs SET status = ?1, updated_at = {SET_NOW} \
                     WHERE id = ?2 AND work_item_id = ?3"
                ),
                params![status, run_id, work_item_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn start_run(&mut self, new: NewRun) -> Result<Run> {
        let agent = new.agent.map(|a| a.as_str());
        let setting_up = Status::SettingUp.as_str();

        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO run_counter DEFAULT VALUES", [])?;
        let id = format!("run-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO runs (id, work_item_id, agent, branch, worktree_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                new.work_item_id,
                agent,
                new.branch,
                new.worktree_path,
                setting_up,
            ],
        )?;
        let affected = tx.execute(
            "UPDATE work_items
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![setting_up, new.work_item_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("work item not found: {}", new.work_item_id));
        }

        let run = {
            let mut stmt = tx.prepare(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => Run::from_row(row)?,
                None => return Err(anyhow!("inserted run {id} not found")),
            }
        };
        tx.commit()?;
        Ok(run)
    }

    /// Settle a run attempt to a terminal status (`running` / `failed`), updating both the run and
    /// its work item in one transaction so the pair can never drift.
    pub fn finish_run(&mut self, run_id: &str, work_item_id: &str, status: Status) -> Result<()> {
        let status = status.as_str();
        let tx = self.conn_mut().transaction()?;
        let run_affected = tx.execute(
            "UPDATE runs
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![status, run_id],
        )?;
        if run_affected == 0 {
            return Err(anyhow!("run not found: {run_id}"));
        }
        let item_affected = tx.execute(
            "UPDATE work_items
               SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![status, work_item_id],
        )?;
        if item_affected == 0 {
            return Err(anyhow!("work item not found: {work_item_id}"));
        }
        tx.commit()?;
        Ok(())
    }

    /// Recording `settings_path` is not a status transition, so it stays out of `finish_run` and
    /// runs as a single UPDATE on its own.
    pub fn set_run_settings_path(&self, run_id: &str, settings_path: &str) -> Result<()> {
        let affected = self.conn().execute(
            "UPDATE runs
               SET settings_path = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?2",
            params![settings_path, run_id],
        )?;
        if affected == 0 {
            return Err(anyhow!("run not found: {run_id}"));
        }
        Ok(())
    }

    pub fn get_run(&self, id: &str) -> Result<Option<Run>> {
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(Run::from_row(row)?)),
            None => Ok(None),
        }
    }
}
