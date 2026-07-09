use anyhow::Result;
use rusqlite::{params, Connection};

use crate::SqliteStore;
use monica_application::GithubPullRequestRef;
use monica_domain::ExternalReference;

pub(super) fn list_external_refs(conn: &Connection, task_id: &str) -> Result<Vec<ExternalReference>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, provider, ref_type, repo, number, url, created_at
         FROM external_refs WHERE task_id = ?1 ORDER BY id",
    )?;
    let mut rows = stmt.query(params![task_id])?;
    let mut refs = Vec::new();
    while let Some(row) = rows.next()? {
        refs.push(crate::row::external_ref_from_row(row)?);
    }
    Ok(refs)
}

impl SqliteStore {
    pub fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalReference>> {
        list_external_refs(self.conn(), task_id)
    }

    pub fn list_github_pull_request_refs(
        &self,
        task_id: &str,
    ) -> Result<Vec<GithubPullRequestRef>> {
        let mut stmt = self.conn().prepare(
            "SELECT pr.repo, pr.number, pr.url, state.status
             FROM external_refs pr
             LEFT JOIN github_pull_request_ref_states state
               ON state.external_ref_id = pr.id
             WHERE pr.task_id = ?1 AND pr.ref_type = 'pull_request'
             ORDER BY pr.id",
        )?;
        let mut rows = stmt.query(params![task_id])?;
        let mut refs = Vec::new();
        while let Some(row) = rows.next()? {
            let status: Option<String> = row.get("status")?;
            refs.push(GithubPullRequestRef {
                repo: row.get("repo")?,
                number: row.get("number")?,
                url: row.get("url")?,
                is_open_or_draft: GithubPullRequestRef::status_is_open_or_draft(status.as_deref()),
                status,
            });
        }
        Ok(refs)
    }
}
