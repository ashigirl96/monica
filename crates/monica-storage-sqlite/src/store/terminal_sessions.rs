use anyhow::Result;
use monica_application::ports::TerminalSessionRepository;
use monica_application::{TerminalSessionUpdate, TerminalStateSnapshot};
use monica_domain::{
    AgentSessionStatus, NewTerminalSession, ProviderSessionEvent, TaskRunWaitReason,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
use rusqlite::{params, OptionalExtension, Row, Transaction, TransactionBehavior};

use monica_paths as paths;
use crate::SqliteStore;

use super::SET_NOW;

const SESSION_COLUMNS: &str = "id, runspace_id, tab_id, kind, cwd, shell, status, agent_status, agent_wait_reason,      provider_session_id, pid, rows, cols, transcript_path, exit_code, started_at, last_seen_at,      exited_at, created_at, updated_at";
type AgentStateRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn session_from_row(row: &Row<'_>) -> Result<TerminalSession> {
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    let agent_status: Option<String> = row.get("agent_status")?;
    let agent_wait_reason: Option<String> = row.get("agent_wait_reason")?;
    Ok(TerminalSession {
        id: row.get("id")?,
        runspace_id: row.get("runspace_id")?,
        tab_id: row.get("tab_id")?,
        kind: kind.parse::<TerminalSessionKind>()?,
        cwd: row.get("cwd")?,
        shell: row.get("shell")?,
        status: status.parse::<TerminalSessionStatus>()?,
        agent_status: agent_status.map(|s| s.parse()).transpose()?,
        agent_wait_reason: agent_wait_reason.map(|s| s.parse()).transpose()?,
        provider_session_id: row.get("provider_session_id")?,
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

    /// Update the hook-observed agent state. A missing row is a no-op: hooks can outlive their
    /// session (stale env after a respawn), and an indicator update must never fail the hook.
    pub fn set_terminal_session_agent_status(
        &self,
        id: &str,
        agent_status: Option<AgentSessionStatus>,
        agent_wait_reason: Option<TaskRunWaitReason>,
        provider_session_id: Option<&str>,
        provider_event: ProviderSessionEvent,
    ) -> Result<bool> {
        let tx = Transaction::new_unchecked(self.conn(), TransactionBehavior::Immediate)?;
        let current: Option<AgentStateRow> = tx
            .query_row(
                "SELECT agent_status, agent_wait_reason, provider_session_id,
                        provider_handoff_from
                   FROM terminal_sessions WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((current_status, current_reason, current_provider, current_handoff)) = current
        else {
            tx.commit()?;
            return Ok(false);
        };

        let Some(binding) = provider_event.reconcile(
            current_provider.as_deref(),
            current_handoff.as_deref(),
            provider_session_id,
        ) else {
            tx.commit()?;
            return Ok(false);
        };

        let status = agent_status.map(AgentSessionStatus::as_str);
        let reason = agent_wait_reason.map(TaskRunWaitReason::as_str);
        let state_changed = current_status.as_deref() != status || current_reason.as_deref() != reason;
        tx.execute(
            &format!(
                "UPDATE terminal_sessions
                    SET agent_status = ?2, agent_wait_reason = ?3,
                        provider_session_id = ?4, provider_handoff_from = ?5,
                        updated_at = {SET_NOW}
                  WHERE id = ?1"
            ),
            params![
                id,
                status,
                reason,
                binding.provider_session_id,
                binding.handoff_from
            ],
        )?;
        tx.commit()?;
        Ok(state_changed)
    }

    pub fn clear_terminal_session_agent_status(
        &self,
        id: &str,
        provider_session_id: Option<&str>,
    ) -> Result<()> {
        self.conn().execute(
            &format!(
                "UPDATE terminal_sessions
                    SET agent_status = NULL, agent_wait_reason = NULL,
                        provider_session_id = NULL, provider_handoff_from = NULL,
                        updated_at = {SET_NOW}
                  WHERE id = ?1 AND provider_session_id IS ?2"
            ),
            params![id, provider_session_id],
        )?;
        Ok(())
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
                            agent_status = CASE WHEN ?6 THEN NULL ELSE agent_status END,
                            agent_wait_reason = CASE WHEN ?6 THEN NULL ELSE agent_wait_reason END,
                            provider_session_id = CASE WHEN ?6 THEN NULL ELSE provider_session_id END,
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

    fn set_terminal_session_agent_status(
        &self,
        id: &str,
        agent_status: Option<AgentSessionStatus>,
        agent_wait_reason: Option<TaskRunWaitReason>,
        provider_session_id: Option<&str>,
        provider_event: ProviderSessionEvent,
    ) -> Result<bool> {
        SqliteStore::set_terminal_session_agent_status(
            self,
            id,
            agent_status,
            agent_wait_reason,
            provider_session_id,
            provider_event,
        )
    }

    fn clear_terminal_session_agent_status(
        &self,
        id: &str,
        provider_session_id: Option<&str>,
    ) -> Result<()> {
        SqliteStore::clear_terminal_session_agent_status(self, id, provider_session_id)
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

    fn load_terminal_state(&self, window_label: &str) -> Result<TerminalStateSnapshot> {
        SqliteStore::load_terminal_state(self, window_label)
    }

    fn save_terminal_state(
        &mut self,
        window_label: &str,
        snapshot: &TerminalStateSnapshot,
    ) -> Result<()> {
        SqliteStore::save_terminal_state(self, window_label, snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_session(db: &mut SqliteStore) -> TerminalSession {
        db.create_terminal_session(NewTerminalSession {
            runspace_id: None,
            tab_id: Some("tab-1".to_string()),
            kind: TerminalSessionKind::Agent,
            cwd: "/tmp".to_string(),
            shell: "/bin/zsh".to_string(),
            rows: 24,
            cols: 80,
        })
        .unwrap()
    }

    #[test]
    fn session_start_can_rebind_provider_without_reporting_a_state_edge() {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let session = create_session(&mut db);

        assert!(db
            .set_terminal_session_agent_status(
                &session.id,
                Some(AgentSessionStatus::Running),
                None,
                Some("provider-old"),
                ProviderSessionEvent::Started,
            )
            .unwrap());
        assert!(!db
            .set_terminal_session_agent_status(
                &session.id,
                Some(AgentSessionStatus::Running),
                None,
                Some("provider-new"),
                ProviderSessionEvent::Started,
            )
            .unwrap());

        let stored = db.get_terminal_session(&session.id).unwrap().unwrap();
        assert_eq!(stored.provider_session_id.as_deref(), Some("provider-new"));
    }

    #[test]
    fn stale_provider_events_cannot_overwrite_or_clear_the_active_provider() {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let session = create_session(&mut db);
        db.set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::Running),
            None,
            Some("provider-old"),
            ProviderSessionEvent::Started,
        )
        .unwrap();
        db.set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::Running),
            None,
            Some("provider-new"),
            ProviderSessionEvent::Started,
        )
        .unwrap();

        assert!(!db
            .set_terminal_session_agent_status(
                &session.id,
                Some(AgentSessionStatus::WaitingForUser),
                Some(TaskRunWaitReason::PermissionRequest),
                Some("provider-old"),
                ProviderSessionEvent::Observed,
            )
            .unwrap());
        db.clear_terminal_session_agent_status(&session.id, Some("provider-old"))
            .unwrap();

        let stored = db.get_terminal_session(&session.id).unwrap().unwrap();
        assert_eq!(stored.agent_status, Some(AgentSessionStatus::Running));
        assert_eq!(stored.provider_session_id.as_deref(), Some("provider-new"));

        db.clear_terminal_session_agent_status(&session.id, Some("provider-new"))
            .unwrap();
        let cleared = db.get_terminal_session(&session.id).unwrap().unwrap();
        assert_eq!(cleared.agent_status, None);
        assert_eq!(cleared.provider_session_id, None);
    }

    #[test]
    fn resume_handoff_is_persisted_and_consumed_once() {
        let mut db = SqliteStore::open_in_memory().unwrap();
        let session = create_session(&mut db);
        db.set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::Running),
            None,
            Some("provider-source"),
            ProviderSessionEvent::ResumeStarted,
        )
        .unwrap();

        db.set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::Running),
            None,
            Some("provider-source"),
            ProviderSessionEvent::PromptSubmitted,
        )
        .unwrap();
        db.set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::Running),
            None,
            Some("provider-new"),
            ProviderSessionEvent::PromptSubmitted,
        )
        .unwrap();
        db.set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::WaitingForUser),
            Some(TaskRunWaitReason::PermissionRequest),
            Some("provider-late"),
            ProviderSessionEvent::PromptSubmitted,
        )
        .unwrap();

        let stored = db.get_terminal_session(&session.id).unwrap().unwrap();
        assert_eq!(stored.provider_session_id.as_deref(), Some("provider-new"));
        assert_eq!(stored.agent_status, Some(AgentSessionStatus::Running));
    }
}
