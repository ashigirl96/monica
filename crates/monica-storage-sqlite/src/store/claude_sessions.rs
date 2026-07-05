use anyhow::Result;
use monica_application::ports::ClaudeSessionRepository;
use monica_domain::{ClaudeSession, ClaudeSessionStatus, NewClaudeSession, TerminalSessionStatus};
use rusqlite::{params, Row};

use crate::SqliteStore;

use super::{sql_literal_list, SET_NOW};

const CLAUDE_SESSION_COLUMNS: &str = "claude_session_id, runspace_id, tab_id, terminal_session_id, cwd, name, status,      created_at, ended_at";

fn claude_session_from_row(row: &Row<'_>) -> Result<ClaudeSession> {
    let status: String = row.get("status")?;
    Ok(ClaudeSession {
        claude_session_id: row.get("claude_session_id")?,
        runspace_id: row.get("runspace_id")?,
        tab_id: row.get("tab_id")?,
        terminal_session_id: row.get("terminal_session_id")?,
        cwd: row.get("cwd")?,
        name: row.get("name")?,
        status: status.parse::<ClaudeSessionStatus>()?,
        created_at: row.get("created_at")?,
        ended_at: row.get("ended_at")?,
    })
}

impl SqliteStore {
    /// The initial status is read from the terminal session's row inside the INSERT itself:
    /// the PTY reader thread may have already settled the row as exited between the caller's
    /// launch write and this insert, and SQLite's writer serialization guarantees one of the
    /// two orders — settled-first lands here as `ended`, settled-after is caught by the
    /// coupled UPDATE in `apply_terminal_session_updates`.
    pub fn create_claude_session(&mut self, new: NewClaudeSession) -> Result<ClaudeSession> {
        let settled = sql_literal_list([
            TerminalSessionStatus::Exited.as_str(),
            TerminalSessionStatus::Lost.as_str(),
            TerminalSessionStatus::Failed.as_str(),
        ]);
        let active = ClaudeSessionStatus::Active.as_str();
        let ended = ClaudeSessionStatus::Ended.as_str();
        let inserted = self.conn().execute(
            &format!(
                "INSERT INTO claude_sessions
                   (claude_session_id, runspace_id, tab_id, terminal_session_id, cwd, name,
                    status, ended_at)
                 SELECT ?1, ?2, ?3, ts.id, ?5, ?6,
                        CASE WHEN ts.status IN ({settled}) THEN '{ended}' ELSE '{active}' END,
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

    fn get_claude_session(&self, claude_session_id: &str) -> Result<Option<ClaudeSession>> {
        SqliteStore::get_claude_session(self, claude_session_id)
    }

    fn list_claude_sessions(&self) -> Result<Vec<ClaudeSession>> {
        SqliteStore::list_claude_sessions(self)
    }
}
