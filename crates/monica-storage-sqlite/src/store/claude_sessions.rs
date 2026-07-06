use anyhow::Result;
use monica_application::ports::{
    ClaudeSessionEvent, ClaudeSessionObservation, ClaudeSessionRepository,
};
use monica_domain::{
    ClaudeConversationStatus, ClaudeLaunchPhase, ClaudeSession, ClaudeSessionStatus,
    NewClaudeSession, TaskRunWaitReason, TerminalSessionStatus,
};
use rusqlite::{params, Row};

use crate::SqliteStore;

use super::{sql_literal_list, SET_NOW};

const CLAUDE_SESSION_COLUMNS: &str = "claude_session_id, runspace_id, tab_id, terminal_session_id, cwd, name, status, launch_phase, conversation_status, wait_reason, provider_session_id, jsonl_offset, created_at, ended_at";

const CLAUDE_SESSION_EVENT_COLUMNS: &str =
    "id, claude_session_id, kind, payload_json, created_at";

fn claude_session_from_row(row: &Row<'_>) -> Result<ClaudeSession> {
    let status: String = row.get("status")?;
    let launch_phase: String = row.get("launch_phase")?;
    let conversation_status: String = row.get("conversation_status")?;
    let wait_reason: Option<String> = row.get("wait_reason")?;
    let jsonl_offset: i64 = row.get("jsonl_offset")?;
    Ok(ClaudeSession {
        claude_session_id: row.get("claude_session_id")?,
        runspace_id: row.get("runspace_id")?,
        tab_id: row.get("tab_id")?,
        terminal_session_id: row.get("terminal_session_id")?,
        cwd: row.get("cwd")?,
        name: row.get("name")?,
        status: status.parse::<ClaudeSessionStatus>()?,
        launch_phase: launch_phase.parse::<ClaudeLaunchPhase>()?,
        conversation_status: conversation_status.parse::<ClaudeConversationStatus>()?,
        wait_reason: wait_reason
            .as_deref()
            .map(str::parse::<TaskRunWaitReason>)
            .transpose()?,
        provider_session_id: row.get("provider_session_id")?,
        jsonl_offset: u64::try_from(jsonl_offset).unwrap_or(0),
        created_at: row.get("created_at")?,
        ended_at: row.get("ended_at")?,
    })
}

fn claude_session_event_from_row(row: &Row<'_>) -> rusqlite::Result<ClaudeSessionEvent> {
    Ok(ClaudeSessionEvent {
        id: row.get("id")?,
        claude_session_id: row.get("claude_session_id")?,
        kind: row.get("kind")?,
        payload_json: row.get("payload_json")?,
        created_at: row.get("created_at")?,
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

    /// Remove a reservation whose launch was provably never attempted, freeing the id
    /// for a clean retry (see the port doc for why an attempted launch must keep a row).
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

    /// One hook signal, atomically: the event row and the observation land in a single
    /// transaction, so the drain never sees an event whose session row lags behind it.
    /// Unknown id → `None` with nothing written (a hook from a session Monica never
    /// launched). Deliberately never touches `status = pending → active`: that
    /// confirmation belongs to the open flow.
    pub fn record_claude_session_signal(
        &mut self,
        claude_session_id: &str,
        kind: &str,
        payload_json: &str,
        observation: ClaudeSessionObservation<'_>,
    ) -> Result<Option<ClaudeSession>> {
        let tx = self.conn_mut().transaction()?;
        let exists: i64 = tx.query_row(
            "SELECT count(*) FROM claude_sessions WHERE claude_session_id = ?1",
            params![claude_session_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(None);
        }
        tx.execute(
            "INSERT INTO claude_session_events (claude_session_id, kind, payload_json)
             VALUES (?1, ?2, ?3)",
            params![claude_session_id, kind, payload_json],
        )?;
        if let Some(provider_session_id) = observation.provider_session_id {
            // Latest wins; a change means Claude writes a different transcript file now,
            // so the cursor restarts. `IS NOT` is NULL-safe (the first stamp also resets,
            // harmlessly — nothing was read before the first hook).
            tx.execute(
                "UPDATE claude_sessions
                    SET jsonl_offset = CASE
                            WHEN provider_session_id IS NOT ?2 THEN 0 ELSE jsonl_offset
                        END,
                        provider_session_id = ?2
                  WHERE claude_session_id = ?1",
                params![claude_session_id, provider_session_id],
            )?;
        }
        tx.execute(
            "UPDATE claude_sessions
                SET conversation_status = COALESCE(?2, conversation_status),
                    wait_reason = CASE WHEN ?3 THEN ?4 ELSE wait_reason END
              WHERE claude_session_id = ?1",
            params![
                claude_session_id,
                observation.conversation_status.map(|s| s.as_str()),
                observation.wait_reason.is_some(),
                observation.wait_reason.flatten().map(|r| r.as_str()),
            ],
        )?;
        if observation.mark_ended {
            let ended = ClaudeSessionStatus::Ended.as_str();
            tx.execute(
                &format!(
                    "UPDATE claude_sessions
                        SET status = '{ended}',
                            ended_at = COALESCE(ended_at, {SET_NOW})
                      WHERE claude_session_id = ?1 AND status != '{ended}'"
                ),
                params![claude_session_id],
            )?;
        }
        tx.commit()?;
        self.get_claude_session(claude_session_id)
    }

    pub fn list_unconsumed_claude_session_events(
        &self,
        limit: usize,
    ) -> Result<Vec<ClaudeSessionEvent>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {CLAUDE_SESSION_EVENT_COLUMNS} FROM claude_session_events
              WHERE consumed_at IS NULL ORDER BY id LIMIT ?1"
        ))?;
        let rows = stmt
            .query_map(params![limit as i64], claude_session_event_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn mark_claude_session_events_consumed(&mut self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let id_list = ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        self.conn().execute(
            &format!(
                "UPDATE claude_session_events SET consumed_at = {SET_NOW}
                  WHERE id IN ({id_list})"
            ),
            [],
        )?;
        Ok(())
    }

    pub fn set_claude_session_jsonl_offset(
        &mut self,
        claude_session_id: &str,
        offset: u64,
    ) -> Result<()> {
        self.conn().execute(
            "UPDATE claude_sessions SET jsonl_offset = ?2 WHERE claude_session_id = ?1",
            params![claude_session_id, offset as i64],
        )?;
        Ok(())
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

    fn record_claude_session_signal(
        &mut self,
        claude_session_id: &str,
        kind: &str,
        payload_json: &str,
        observation: ClaudeSessionObservation<'_>,
    ) -> Result<Option<ClaudeSession>> {
        SqliteStore::record_claude_session_signal(
            self,
            claude_session_id,
            kind,
            payload_json,
            observation,
        )
    }

    fn list_unconsumed_claude_session_events(
        &self,
        limit: usize,
    ) -> Result<Vec<ClaudeSessionEvent>> {
        SqliteStore::list_unconsumed_claude_session_events(self, limit)
    }

    fn mark_claude_session_events_consumed(&mut self, ids: &[i64]) -> Result<()> {
        SqliteStore::mark_claude_session_events_consumed(self, ids)
    }

    fn set_claude_session_jsonl_offset(
        &mut self,
        claude_session_id: &str,
        offset: u64,
    ) -> Result<()> {
        SqliteStore::set_claude_session_jsonl_offset(self, claude_session_id, offset)
    }
}
