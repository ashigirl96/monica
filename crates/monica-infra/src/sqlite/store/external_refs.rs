use anyhow::Result;
use rusqlite::params;

use crate::sqlite::SqliteStore;
use monica_core::{ExternalRef, GithubPullRequestRef};

impl SqliteStore {
    pub fn save_external_ref(&self, r: &ExternalRef) -> Result<i64> {
        self.conn().execute(
            "INSERT INTO external_refs (task_id, ref_type, repo, number, url)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![r.task_id, r.ref_type.as_str(), r.repo, r.number, r.url],
        )?;
        Ok(self.conn().last_insert_rowid())
    }

    pub fn list_external_refs(&self, task_id: &str) -> Result<Vec<ExternalRef>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, task_id, ref_type, repo, number, url, created_at
             FROM external_refs WHERE task_id = ?1 ORDER BY id",
        )?;
        let mut rows = stmt.query(params![task_id])?;
        let mut refs = Vec::new();
        while let Some(row) = rows.next()? {
            refs.push(crate::sqlite::row::external_ref_from_row(row)?);
        }
        Ok(refs)
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
             WHERE pr.task_id = ?1 AND pr.ref_type = 'github_pull_request'
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
