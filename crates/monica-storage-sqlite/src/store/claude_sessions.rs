use anyhow::Result;
use monica_application::ports::ClaudeSessionRepository;
use monica_domain::{
    ClaudeLaunchPhase, ClaudeSession, ClaudeSessionStatus, NewClaudeSession,
    TerminalSessionStatus,
};
use rusqlite::{params, Row};

use crate::SqliteStore;

use super::{sql_literal_list, SET_NOW};

const CLAUDE_SESSION_COLUMNS: &str = "claude_session_id, runspace_id, tab_id, terminal_session_id, cwd, name, status, launch_phase, created_at, ended_at";

fn claude_session_from_row(row: &Row<'_>) -> Result<ClaudeSession> {
    let status: String = row.get("status")?;
    let launch_phase: String = row.get("launch_phase")?;
    Ok(ClaudeSession {
        claude_session_id: row.get("claude_session_id")?,
        runspace_id: row.get("runspace_id")?,
        tab_id: row.get("tab_id")?,
        terminal_session_id: row.get("terminal_session_id")?,
        cwd: row.get("cwd")?,
        name: row.get("name")?,
        status: status.parse::<ClaudeSessionStatus>()?,
        launch_phase: launch_phase.parse::<ClaudeLaunchPhase>()?,
        created_at: row.get("created_at")?,
        ended_at: row.get("ended_at")?,
    })
}

impl SqliteStore {
    /// Reserve the mapping row before the launch is submitted. The initial status is read
    /// from the terminal session's row inside the INSERT itself: the PTY reader thread may
    /// settle the row as exited concurrently, and SQLite's writer serialization guarantees
    /// one of the two orders — settled-first lands here as `ended`, settled-after is caught
    /// by the coupled UPDATE in `apply_terminal_session_updates`.
    pub fn create_claude_session(&mut self, new: NewClaudeSession) -> Result<ClaudeSession> {
        let settled = sql_literal_list([
            TerminalSessionStatus::Exited.as_str(),
            TerminalSessionStatus::Lost.as_str(),
            TerminalSessionStatus::Failed.as_str(),
        ]);
        let pending = ClaudeSessionStatus::Pending.as_str();
        let ended = ClaudeSessionStatus::Ended.as_str();
        let reserved = ClaudeLaunchPhase::Reserved.as_str();
        let inserted = self.conn().execute(
            &format!(
                "INSERT INTO claude_sessions
                   (claude_session_id, runspace_id, tab_id, terminal_session_id, cwd, name,
                    status, launch_phase, ended_at)
                 SELECT ?1, ?2, ?3, ts.id, ?5, ?6,
                        CASE WHEN ts.status IN ({settled}) THEN '{ended}' ELSE '{pending}' END,
                        '{reserved}',
                        CASE WHEN ts.status IN ({settled}) THEN {SET_NOW} ELSE NULL END
                   FROM terminal_sessions ts WHERE ts.id = ?4"
            ),
            params![
                new.claude_session_id,
                new.runspace_id,
                new.tab_id,
                new.terminal_session_id,
                new.cwd,
                new.name
            ],
        )?;
        if inserted == 0 {
            anyhow::bail!(
                "terminal session {} not found; refusing to map claude session {} to nothing",
                new.terminal_session_id,
                new.claude_session_id
            );
        }
        self.get_claude_session(&new.claude_session_id)?.ok_or_else(|| {
            anyhow::anyhow!("claude session {} vanished after insert", new.claude_session_id)
        })
    }

    /// Stamp that a launch write is about to go out: launch_phase reserved → submitting.
    /// Written BEFORE the write, so a pending row still in `reserved` provably never
    /// received a launch. `false` means the row already left that state.
    pub fn mark_claude_session_submitting(&mut self, claude_session_id: &str) -> Result<bool> {
        let pending = ClaudeSessionStatus::Pending.as_str();
        let reserved = ClaudeLaunchPhase::Reserved.as_str();
        let submitting = ClaudeLaunchPhase::Submitting.as_str();
        let updated = self.conn().execute(
            &format!(
                "UPDATE claude_sessions SET launch_phase = '{submitting}'
                  WHERE claude_session_id = ?1 AND status = '{pending}'
                    AND launch_phase = '{reserved}'"
            ),
            params![claude_session_id],
        )?;
        Ok(updated > 0)
    }

    /// Seconds since the row was created, from SQLite's own clock (the one that stamped
    /// `created_at`) — used to tell a stale crash-leftover reservation from an in-flight
    /// open. `None` when the row does not exist.
    pub fn claude_session_age_seconds(&self, claude_session_id: &str) -> Result<Option<i64>> {
        let mut stmt = self.conn().prepare(
            "SELECT CAST(strftime('%s','now') AS INTEGER)
                    - CAST(strftime('%s', created_at) AS INTEGER)
               FROM claude_sessions WHERE claude_session_id = ?1",
        )?;
        let mut rows = stmt.query(params![claude_session_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// Confirm the launch write reached the PTY: pending → active. `false` means the row is
    /// no longer pending — the PTY settled (and the coupled transition ended the mapping)
    /// before the launch was confirmed, so the caller must treat the open as failed.
    pub fn mark_claude_session_launched(&mut self, claude_session_id: &str) -> Result<bool> {
        let pending = ClaudeSessionStatus::Pending.as_str();
        let active = ClaudeSessionStatus::Active.as_str();
        let updated = self.conn().execute(
            &format!(
                "UPDATE claude_sessions SET status = '{active}'
                  WHERE claude_session_id = ?1 AND status = '{pending}'"
            ),
            params![claude_session_id],
        )?;
        Ok(updated > 0)
    }

    /// Remove a reservation whose launch never happened, freeing the id for a clean retry.
    pub fn delete_claude_session(&mut self, claude_session_id: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM claude_sessions WHERE claude_session_id = ?1",
            params![claude_session_id],
        )?;
        Ok(())
    }

    pub fn get_claude_session(&self, claude_session_id: &str) -> Result<Option<ClaudeSession>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {CLAUDE_SESSION_COLUMNS} FROM claude_sessions WHERE claude_session_id = ?1"
        ))?;
        let mut rows = stmt.query(params![claude_session_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(claude_session_from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_claude_sessions(&self) -> Result<Vec<ClaudeSession>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {CLAUDE_SESSION_COLUMNS} FROM claude_sessions ORDER BY created_at"
        ))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(claude_session_from_row(row).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        e.into(),
                    )
                }))
            })?
            .collect::<Result<Result<Vec<_>, _>, _>>()??;
        Ok(rows)
    }
}

impl ClaudeSessionRepository for SqliteStore {
    fn create_claude_session(&mut self, new: NewClaudeSession) -> Result<ClaudeSession> {
        SqliteStore::create_claude_session(self, new)
    }

    fn mark_claude_session_submitting(&mut self, claude_session_id: &str) -> Result<bool> {
        SqliteStore::mark_claude_session_submitting(self, claude_session_id)
    }

    fn claude_session_age_seconds(&self, claude_session_id: &str) -> Result<Option<i64>> {
        SqliteStore::claude_session_age_seconds(self, claude_session_id)
    }

    fn mark_claude_session_launched(&mut self, claude_session_id: &str) -> Result<bool> {
        SqliteStore::mark_claude_session_launched(self, claude_session_id)
    }

    fn delete_claude_session(&mut self, claude_session_id: &str) -> Result<()> {
        SqliteStore::delete_claude_session(self, claude_session_id)
    }

    fn get_claude_session(&self, claude_session_id: &str) -> Result<Option<ClaudeSession>> {
        SqliteStore::get_claude_session(self, claude_session_id)
    }

    fn list_claude_sessions(&self) -> Result<Vec<ClaudeSession>> {
        SqliteStore::list_claude_sessions(self)
    }
}
