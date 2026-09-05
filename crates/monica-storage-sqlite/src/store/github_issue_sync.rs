use std::str::FromStr;

use anyhow::Result;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::SqliteStore;
use monica_application::{
    FetchedIssue, FieldChange, GithubIssueState, GithubIssueSyncStore, IssueSyncChange,
    OpenIssueRef,
};

use super::SET_NOW;

impl SqliteStore {
    pub fn all_open_task_issue_refs(&self) -> Result<Vec<OpenIssueRef>> {
        let mut stmt = self.conn().prepare(
            "SELECT
               t.id AS task_id,
               er.id AS external_ref_id,
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
                    task_id: row.get("task_id")?,
                    external_ref_id: row.get("external_ref_id")?,
                    repo: row.get("repo")?,
                    number: row.get("number")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(refs)
    }

    pub fn bulk_record_issue_sync(
        &mut self,
        entries: &[(OpenIssueRef, FetchedIssue)],
    ) -> Result<Vec<IssueSyncChange>> {
        // Immediate: this transaction reads each cached row before overwriting it, and a DEFERRED
        // transaction that starts with a read gets SQLITE_BUSY without consulting the busy handler
        // when it later tries to upgrade to a write lock. Same reason as the notes store's
        // `get_or_create_daily_note`.
        let tx = self
            .conn_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut changes = Vec::new();
        for (issue_ref, issue) in entries {
            let (previous_title, previous_state) =
                read_issue_ref_state(&tx, issue_ref.external_ref_id)?;
            upsert_issue_ref_state_in(&tx, issue_ref.external_ref_id, &issue.title, issue.state)?;
            let title = FieldChange::detect(previous_title, issue.title.clone());
            let state = FieldChange::detect(previous_state, issue.state);
            if title.is_some() || state.is_some() {
                changes.push(IssueSyncChange {
                    task_id: issue_ref.task_id.clone(),
                    repo: issue_ref.repo.clone(),
                    number: issue_ref.number,
                    title,
                    state,
                });
            }
        }
        tx.commit()?;
        Ok(changes)
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

    fn bulk_record_issue_sync(
        &mut self,
        entries: &[(OpenIssueRef, FetchedIssue)],
    ) -> Result<Vec<IssueSyncChange>> {
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

/// The cached title and state, each `None` when the row is missing or the column was never
/// filled. Read before the upsert so the caller can tell a changed value from a first fetch.
fn read_issue_ref_state(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
) -> Result<(Option<String>, Option<GithubIssueState>)> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT title, state FROM github_issue_ref_states WHERE external_ref_id = ?1",
            params![external_ref_id],
            |row| Ok((row.get("title")?, row.get("state")?)),
        )
        .optional()?;
    let (title, state) = row.unwrap_or((None, None));
    Ok((
        title,
        state.and_then(|s| GithubIssueState::from_str(&s).ok()),
    ))
}
