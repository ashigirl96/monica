use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::SqliteStore;
use monica_application::{
    FetchedIssue, GithubIssueState, GithubIssueSyncStore, IssueAddress, IssueBlocker, OpenIssueRef,
};
use monica_domain::{Provider, RefType};

use super::{task_scope_clause, SET_NOW};

impl SqliteStore {
    pub fn open_task_issue_refs(&self, task: Option<&str>) -> Result<Vec<OpenIssueRef>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT
               er.id AS external_ref_id,
               er.task_id AS task_id,
               er.repo AS repo,
               er.number AS number
             FROM external_refs er
             JOIN tasks t ON t.id = er.task_id
             WHERE er.ref_type = 'issue'
               AND er.provider = 'github'
               AND t.status != 'closed'{}
               AND er.repo IS NOT NULL
               AND er.number IS NOT NULL
               AND er.number > 0
             ORDER BY er.id",
            task_scope_clause(task, "er.task_id"),
        ))?;
        let refs = stmt
            .query_map(rusqlite::params_from_iter(task), |row| {
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
            record_parent_task_in(&tx, *external_ref_id, issue.parent.as_ref())?;
            record_issue_blockers_in(&tx, *external_ref_id, &issue.blockers)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Every blocker stored for the task's issue refs, exactly as the last sync mirrored them.
    /// Whether a blocker still blocks is not decided here — the rows carry GitHub's raw answer and
    /// [`IssueBlocker::is_cleared`] is the single place that reads it.
    pub fn list_task_blockers(&self, task_id: &str) -> Result<Vec<IssueBlocker>> {
        let mut stmt = self.conn().prepare(
            "SELECT DISTINCT b.repo, b.number, b.state, b.closed_by_merged_pull_request, b.reopened
               FROM github_issue_blockers b
               JOIN external_refs er ON er.id = b.external_ref_id
              WHERE er.task_id = ?1 AND er.ref_type = 'issue'
              ORDER BY b.repo, b.number",
        )?;
        let mut rows = stmt.query(params![task_id])?;
        let mut blockers = Vec::new();
        while let Some(row) = rows.next()? {
            blockers.push(IssueBlocker {
                address: IssueAddress {
                    repo: row.get("repo")?,
                    number: row.get("number")?,
                },
                state: row.get::<_, String>("state")?.parse()?,
                closed_by_merged_pull_request: row.get::<_, i64>("closed_by_merged_pull_request")?
                    != 0,
                reopened: row.get::<_, i64>("reopened")? != 0,
            });
        }
        Ok(blockers)
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
    fn open_task_issue_refs(&self, task: Option<&str>) -> Result<Vec<OpenIssueRef>> {
        SqliteStore::open_task_issue_refs(self, task)
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

    fn list_task_blockers(&self, task_id: &str) -> Result<Vec<IssueBlocker>> {
        SqliteStore::list_task_blockers(self, task_id)
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

/// Replace the blockers recorded for `external_ref_id` with what GitHub reports now. A wholesale
/// rewrite rather than an upsert: an edge dropped on GitHub has to disappear here, and the set is
/// small enough that re-inserting it costs less than reconciling it row by row.
fn record_issue_blockers_in(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
    blockers: &[IssueBlocker],
) -> Result<()> {
    conn.execute(
        "DELETE FROM github_issue_blockers WHERE external_ref_id = ?1",
        params![external_ref_id],
    )?;
    for blocker in blockers {
        conn.execute(
            "INSERT INTO github_issue_blockers
               (external_ref_id, repo, number, state, closed_by_merged_pull_request, reopened)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                external_ref_id,
                blocker.address.repo,
                blocker.address.number,
                blocker.state.as_str(),
                i64::from(blocker.closed_by_merged_pull_request),
                i64::from(blocker.reopened),
            ],
        )?;
    }
    Ok(())
}

/// Point the task behind `external_ref_id` at the task tracking its parent issue, or at nothing
/// when GitHub reports no parent and when the parent issue has no open task. Every sync rewrites
/// this, so a link dropped on GitHub disappears here too. `tasks.updated_at` deliberately stays
/// put: this mirrors GitHub rather than recording a change to the task itself.
///
/// A closed task leaves the sync entirely, freezing its link the same way its cached title and
/// state freeze — what the hierarchy looked like while the task was open is history worth keeping,
/// not a stale claim about GitHub.
fn record_parent_task_in(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
    parent: Option<&IssueAddress>,
) -> Result<()> {
    let parent_task_id = match parent {
        Some(address) => super::tasks::find_open_task_id_by_external_ref_in(
            conn,
            Provider::Github,
            RefType::Issue,
            &address.repo,
            address.number,
        )?,
        None => None,
    };
    // GitHub never lets an issue parent itself, but a stray self-link would be a cycle no reader
    // could walk out of, so the CASE drops it rather than storing it.
    conn.execute(
        "UPDATE tasks
            SET parent_task_id = CASE WHEN ?2 = id THEN NULL ELSE ?2 END
          WHERE id = (SELECT task_id FROM external_refs WHERE id = ?1)",
        params![external_ref_id, parent_task_id],
    )?;
    Ok(())
}
