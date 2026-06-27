use anyhow::Result;
use monica_application::ports::TerminalSessionRepository;
use monica_application::{
    NewTerminalSession, TerminalSession, TerminalSessionKind, TerminalSessionStatus,
    TerminalSessionUpdate, TerminalStateSnapshot,
};
use rusqlite::{params, Row};

use monica_paths as paths;
use crate::SqliteStore;

use super::SET_NOW;

const SESSION_COLUMNS: &str = "id, runspace_id, tab_id, kind, cwd, shell, status, pid, rows, cols,      transcript_path, exit_code, started_at, last_seen_at, exited_at, created_at, updated_at";

fn session_from_row(row: &Row<'_>) -> Result<TerminalSession> {
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    Ok(TerminalSession {
        id: row.get("id")?,
        runspace_id: row.get("runspace_id")?,
        tab_id: row.get("tab_id")?,
        kind: kind.parse::<TerminalSessionKind>()?,
        cwd: row.get("cwd")?,
        shell: row.get("shell")?,
        status: status.parse::<TerminalSessionStatus>()?,
        pid: row.get("pid")?,
        rows: row.get("rows")?,
        cols: row.get("cols")?,
        transcript_path: row.get("transcript_path")?,
        exit_code: row.get("exit_code")?,
        started_at: row.get("started_at")?,
        last_seen_at: row.get("last_seen_at")?,
        exited_at: row.get("exited_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl SqliteStore {
    pub fn create_terminal_session(&mut self, new: NewTerminalSession) -> Result<TerminalSession> {
        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO terminal_session_counter DEFAULT VALUES", [])?;
        let id = format!("ts-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO terminal_sessions
               (id, runspace_id, tab_id, kind, cwd, shell, status, rows, cols)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', ?7, ?8)",
            params![
                id,
                new.runspace_id,
                new.tab_id,
                new.kind.as_str(),
                new.cwd,
                new.shell,
                new.rows,
                new.cols
            ],
        )?;
        tx.commit()?;
        self.get_terminal_session(&id)?
            .ok_or_else(|| anyhow::anyhow!("terminal session {id} vanished after insert"))
    }

    pub fn get_terminal_session(&self, id: &str) -> Result<Option<TerminalSession>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM terminal_sessions WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(session_from_row(row)?)),
            None => Ok(None),
        }
    }

    /// The session most recently created for a tab. A tab respawn always inserts a fresh row,
    /// so this is the only session that may still be driving the tab's run.
    pub fn latest_terminal_session_for_tab(&self, tab_id: &str) -> Result<Option<TerminalSession>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM terminal_sessions
             WHERE tab_id = ?1
             ORDER BY created_at DESC, CAST(SUBSTR(id, 4) AS INTEGER) DESC
             LIMIT 1"
        ))?;
        let mut rows = stmt.query(params![tab_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(session_from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_terminal_sessions(
        &self,
        runspace_id: Option<&str>,
    ) -> Result<Vec<TerminalSession>> {
        let (filter, params): (&str, Vec<&dyn rusqlite::ToSql>) = match &runspace_id {
            Some(rs) => ("WHERE runspace_id = ?1", vec![rs]),
            None => ("", vec![]),
        };
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM terminal_sessions {filter} ORDER BY created_at"
        ))?;
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                Ok(session_from_row(row).map_err(|e| {
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

    /// Record a successful daemon spawn: starting → running with the live pid.
    pub fn mark_terminal_session_started(
        &self,
        id: &str,
        pid: Option<u32>,
        transcript_path: Option<&str>,
    ) -> Result<()> {
        self.conn().execute(
            &format!(
                "UPDATE terminal_sessions
                    SET status = 'running', pid = ?2, transcript_path = ?3,
                        started_at = {SET_NOW}, last_seen_at = {SET_NOW}, updated_at = {SET_NOW}
                  WHERE id = ?1"
            ),
            params![id, pid, transcript_path],
        )?;
        Ok(())
    }

    pub fn update_terminal_session_status(
        &mut self,
        id: &str,
        status: TerminalSessionStatus,
        exit_code: Option<i32>,
    ) -> Result<()> {
        self.apply_terminal_session_updates(&[TerminalSessionUpdate {
            session_id: id.to_string(),
            status,
            pid: None,
            exit_code,
        }])
    }

    /// Apply reconcile results in one transaction. `exited_at` is stamped only on the
    /// transition into a terminal status; `last_seen_at` tracks live observations.
    /// A settled (terminal) row never returns to a live status: a late attach response
    /// racing the daemon's Exit broadcast must not resurrect an exited session.
    pub fn apply_terminal_session_updates(
        &mut self,
        updates: &[TerminalSessionUpdate],
    ) -> Result<()> {
        if updates.is_empty() {
            return Ok(());
        }
        let tx = self.conn_mut().transaction()?;
        for update in updates {
            tx.execute(
                &format!(
                    "UPDATE terminal_sessions
                        SET status = ?2,
                            pid = COALESCE(?3, pid),
                            exit_code = COALESCE(?4, exit_code),
                            last_seen_at = CASE WHEN ?5 THEN {SET_NOW} ELSE last_seen_at END,
                            exited_at = CASE
                                WHEN ?6 AND exited_at IS NULL THEN {SET_NOW}
                                ELSE exited_at
                            END,
                            updated_at = {SET_NOW}
                      WHERE id = ?1
                        AND (?6 OR status NOT IN ('exited', 'lost', 'failed'))"
                ),
                params![
                    update.session_id,
                    update.status.as_str(),
                    update.pid,
                    update.exit_code,
                    !update.status.is_terminal(),
                    update.status.is_terminal(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

impl TerminalSessionRepository for SqliteStore {
    fn create_terminal_session(&mut self, new: NewTerminalSession) -> Result<TerminalSession> {
        SqliteStore::create_terminal_session(self, new)
    }

    fn mark_terminal_session_started(&self, id: &str, pid: Option<u32>) -> Result<()> {
        // The transcript lives at `<terminal_sessions_dir>/<id>.log`; resolving it here keeps path
        // layout an infra concern.
        let transcript_path =
            paths::terminal_sessions_dir().ok().map(|dir| dir.join(format!("{id}.log")));
        SqliteStore::mark_terminal_session_started(
            self,
            id,
            pid,
            transcript_path.as_deref().and_then(|p| p.to_str()),
        )
    }

    fn update_terminal_session_status(
        &mut self,
        id: &str,
        status: TerminalSessionStatus,
        exit_code: Option<i32>,
    ) -> Result<()> {
        SqliteStore::update_terminal_session_status(self, id, status, exit_code)
    }

    fn get_terminal_session(&self, id: &str) -> Result<Option<TerminalSession>> {
        SqliteStore::get_terminal_session(self, id)
    }

    fn latest_terminal_session_for_tab(&self, tab_id: &str) -> Result<Option<TerminalSession>> {
        SqliteStore::latest_terminal_session_for_tab(self, tab_id)
    }

    fn list_terminal_sessions(&self, runspace_id: Option<&str>) -> Result<Vec<TerminalSession>> {
        SqliteStore::list_terminal_sessions(self, runspace_id)
    }

    fn apply_terminal_session_updates(&mut self, updates: &[TerminalSessionUpdate]) -> Result<()> {
        SqliteStore::apply_terminal_session_updates(self, updates)
    }

    fn load_terminal_state(&self) -> Result<TerminalStateSnapshot> {
        SqliteStore::load_terminal_state(self)
    }

    fn save_terminal_state(&mut self, snapshot: &TerminalStateSnapshot) -> Result<()> {
        SqliteStore::save_terminal_state(self, snapshot)
    }
}
