use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::SqliteStore;
use monica_application::{FetchedIssue, GithubIssueState, GithubIssueSyncStore, OpenIssueRef};

use super::SET_NOW;

impl SqliteStore {
    pub fn all_open_task_issue_refs(&self) -> Result<Vec<OpenIssueRef>> {
        let mut stmt = self.conn().prepare(
            "SELECT
               er.id AS external_ref_id,
               er.task_id AS task_id,
               er.repo AS repo,
               er.number AS number
             FROM external_refs er
             JOIN tasks t ON t.id = er.task_id
             WHERE er.ref_type = 'issue'
               AND er.provider = 'github'
               AND t.status != 'closed'
               AND er.repo IS NOT NULL
               AND er.number IS NOT NULL
               AND er.number > 0
             ORDER BY er.id",
        )?;
        let refs = stmt
            .query_map([], |row| {
                Ok(OpenIssueRef {
                    external_ref_id: row.get("external_ref_id")?,
                    task_id: row.get("task_id")?,
                    repo: row.get("repo")?,
                    number: row.get("number")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(refs)
    }

    pub fn bulk_record_issue_sync(&mut self, entries: &[(i64, FetchedIssue)]) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        for (external_ref_id, issue) in entries {
            upsert_issue_ref_state_in(&tx, *external_ref_id, &issue.title, issue.state)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_issue_ref_state(
        &mut self,
        task_id: &str,
        repo: &str,
        number: i64,
        title: &str,
        state: GithubIssueState,
    ) -> Result<()> {
        // Same "newest issue ref wins" rule the task and board reads use, so seeding the cache
        // at track time and refreshing it during a sync always land on the same row.
        let external_ref_id: Option<i64> = self
            .conn()
            .query_row(
                "SELECT id FROM external_refs
                  WHERE task_id = ?1 AND ref_type = 'issue' AND repo = ?2 AND number = ?3
                  ORDER BY id DESC LIMIT 1",
                params![task_id, repo, number],
                |row| row.get(0),
            )
            .optional()?;
        let Some(external_ref_id) = external_ref_id else {
            return Ok(());
        };
        upsert_issue_ref_state_in(self.conn(), external_ref_id, title, state)
    }
}

impl GithubIssueSyncStore for SqliteStore {
    fn all_open_task_issue_refs(&self) -> Result<Vec<OpenIssueRef>> {
        SqliteStore::all_open_task_issue_refs(self)
    }

    fn bulk_record_issue_sync(&mut self, entries: &[(i64, FetchedIssue)]) -> Result<()> {
        SqliteStore::bulk_record_issue_sync(self, entries)
    }

    fn upsert_issue_ref_state(
        &mut self,
        task_id: &str,
        repo: &str,
        number: i64,
        title: &str,
        state: GithubIssueState,
    ) -> Result<()> {
        SqliteStore::upsert_issue_ref_state(self, task_id, repo, number, title, state)
    }
}

fn upsert_issue_ref_state_in(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
    title: &str,
    state: GithubIssueState,
) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO github_issue_ref_states
               (external_ref_id, title, state, updated_at)
             VALUES (?1, ?2, ?3, {SET_NOW})
             ON CONFLICT(external_ref_id) DO UPDATE SET
               title = excluded.title,
               state = excluded.state,
               updated_at = {SET_NOW}"
        ),
        params![external_ref_id, title, state.as_str()],
    )?;
    Ok(())
}
