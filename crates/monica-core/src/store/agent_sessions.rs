use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::Value;

use crate::db::Db;
use crate::model::{AgentSession, AgentSessionStatus, NewAgentSession};

use super::{AGENT_SESSION_COLUMNS, SET_NOW};

impl Db {
    pub fn create_agent_session(&mut self, new: NewAgentSession) -> Result<AgentSession> {
        let metadata = serde_json::to_string(&new.metadata)?;
        let tx = self.conn_mut().transaction()?;
        tx.execute("INSERT INTO agent_session_counter DEFAULT VALUES", [])?;
        let id = format!("session-{}", tx.last_insert_rowid());
        tx.execute(
            "INSERT INTO agent_sessions
               (id, task_id, task_run_id, agent, mode, status, provider_session_id,
                parent_session_id, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                new.task_id,
                new.task_run_id,
                new.agent.as_str(),
                new.mode,
                AgentSessionStatus::Starting.as_str(),
                new.provider_session_id,
                new.parent_session_id,
                metadata,
            ],
        )?;
        let session = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE id = ?1"
            ))?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => AgentSession::from_row(row)?,
                None => return Err(anyhow!("inserted agent session {id} not found")),
            }
        };
        tx.commit()?;
        Ok(session)
    }

    pub fn get_agent_session(&self, id: &str) -> Result<Option<AgentSession>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(AgentSession::from_row(row)?)),
            None => Ok(None),
        }
    }

    pub fn update_agent_session_event(
        &self,
        id: &str,
        status: AgentSessionStatus,
        event_name: Option<&str>,
        at: &str,
        provider_session_id: Option<&str>,
        metadata: Option<&Value>,
    ) -> Result<()> {
        let metadata = metadata.map(serde_json::to_string).transpose()?;
        let affected = self.conn().execute(
            &format!(
                "UPDATE agent_sessions
                   SET status = ?1,
                       last_event_name = COALESCE(?2, last_event_name),
                       last_event_at = ?3,
                       provider_session_id = COALESCE(provider_session_id, ?4),
                       metadata_json = COALESCE(?5, metadata_json),
                       updated_at = {SET_NOW}
                 WHERE id = ?6"
            ),
            params![
                status.as_str(),
                event_name,
                at,
                provider_session_id,
                metadata,
                id
            ],
        )?;
        if affected == 0 {
            return Err(anyhow!("agent session not found: {id}"));
        }
        Ok(())
    }

    pub fn update_agent_session_status(&self, id: &str, status: AgentSessionStatus) -> Result<()> {
        let affected = self.conn().execute(
            &format!("UPDATE agent_sessions SET status = ?1, updated_at = {SET_NOW} WHERE id = ?2"),
            params![status.as_str(), id],
        )?;
        if affected == 0 {
            return Err(anyhow!("agent session not found: {id}"));
        }
        Ok(())
    }
}
