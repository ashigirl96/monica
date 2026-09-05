use anyhow::Result;
use rusqlite::params;

use crate::SqliteStore;
use monica_application::{
    GithubPullRequest, PullRequestBranchSyncCandidate, PullRequestSyncStore,
    UnresolvedPullRequestRef,
};
use monica_domain::{Provider, RefType};

use super::SET_NOW;

// The latest run's branch per development task, joined to its project repo.
const BRANCH_CANDIDATE_FROM: &str = "SELECT
               t.id AS task_id,
               project.repo AS repo,
               latest_run.branch AS branch
             FROM tasks t
             JOIN projects project
               ON project.id = t.project_id
             JOIN task_runs latest_run
               ON latest_run.id = (
                 SELECT r.id
                   FROM task_runs r
                  WHERE r.task_id = t.id
                    AND r.branch IS NOT NULL
                    AND trim(r.branch) != ''
                  ORDER BY r.created_at DESC,
                           CASE
                             WHEN r.id GLOB 'run-[0-9]*' THEN CAST(SUBSTR(r.id, 5) AS INTEGER)
                             ELSE -1
                           END DESC,
                           r.id DESC
                  LIMIT 1
               )";

const BRANCH_CANDIDATE_WHERE: &str = "t.kind = 'development'
               AND project.repo IS NOT NULL
               AND trim(project.repo) != ''
               AND latest_run.branch IS NOT NULL
               AND trim(latest_run.branch) != ''
               AND lower(trim(latest_run.branch)) NOT IN ('main', 'master')
               AND lower(trim(latest_run.branch)) != lower(trim(project.default_branch))";

impl SqliteStore {
    pub fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>> {
        let mut stmt = self.conn().prepare(&format!(
            "{BRANCH_CANDIDATE_FROM}
             WHERE {BRANCH_CANDIDATE_WHERE}
             ORDER BY latest_run.created_at, t.id",
        ))?;
        let candidates = stmt
            .query_map([], |row| {
                Ok(PullRequestBranchSyncCandidate {
                    task_id: row.get("task_id")?,
                    repo: row.get("repo")?,
                    branch: row.get("branch")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(candidates)
    }

    pub fn all_unresolved_pull_request_refs(&self) -> Result<Vec<UnresolvedPullRequestRef>> {
        let mut stmt = self.conn().prepare(
            "SELECT
               pr.id AS external_ref_id,
               pr.task_id AS task_id,
               pr.repo AS repo,
               pr.number AS number
             FROM external_refs pr
             LEFT JOIN github_pull_request_ref_states state
               ON state.external_ref_id = pr.id
             WHERE pr.ref_type = 'pull_request'
               AND pr.repo IS NOT NULL
               AND pr.number IS NOT NULL
               AND pr.number > 0
               AND (state.status IS NULL OR state.status IN ('draft', 'open'))
             ORDER BY pr.id",
        )?;
        let refs = stmt
            .query_map([], |row| {
                Ok(UnresolvedPullRequestRef {
                    external_ref_id: row.get("external_ref_id")?,
                    task_id: row.get("task_id")?,
                    repo: row.get("repo")?,
                    number: row.get("number")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(refs)
    }

    pub fn bulk_record_pr_sync(
        &mut self,
        branch_entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
        status_entries: &[(UnresolvedPullRequestRef, GithubPullRequest)],
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        for (candidate, pull_requests) in branch_entries {
            for pull_request in pull_requests {
                upsert_pull_request_ref(&tx, &candidate.task_id, pull_request)?;
            }
        }
        for (unresolved_ref, pull_request) in status_entries {
            tx.execute(
                "UPDATE external_refs
                    SET url = ?1
                  WHERE id = ?2",
                params![&pull_request.url, unresolved_ref.external_ref_id],
            )?;
            upsert_pr_ref_state_success(
                &tx,
                unresolved_ref.external_ref_id,
                pull_request.status.as_str(),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_linked_pull_requests(
        &mut self,
        entries: &[(String, GithubPullRequest)],
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let tx = self.conn_mut().transaction()?;
        for (task_id, pull_request) in entries {
            upsert_pull_request_ref(&tx, task_id, pull_request)?;
        }
        tx.commit()?;
        Ok(())
    }
}

// PR sync delegates to the inherent methods above; a trait impl cannot span files, so the SQL
// lives here with its tables while [`SqliteStore`] also exposes them inherently.
impl PullRequestSyncStore for SqliteStore {
    fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>> {
        SqliteStore::all_branch_sync_candidates(self)
    }

    fn all_unresolved_pull_request_refs(&self) -> Result<Vec<UnresolvedPullRequestRef>> {
        SqliteStore::all_unresolved_pull_request_refs(self)
    }

    fn bulk_record_pr_sync(
        &mut self,
        branch_entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
        status_entries: &[(UnresolvedPullRequestRef, GithubPullRequest)],
    ) -> Result<()> {
        SqliteStore::bulk_record_pr_sync(self, branch_entries, status_entries)
    }

    fn record_linked_pull_requests(
        &mut self,
        entries: &[(String, GithubPullRequest)],
    ) -> Result<()> {
        SqliteStore::record_linked_pull_requests(self, entries)
    }
}

/// The one place a `pull_request` ref is created. The branch match, the issue reverse lookup and
/// the manual link all land here, so (task, repo, number) stays unique however the PR was found.
fn upsert_pull_request_ref(
    conn: &rusqlite::Connection,
    task_id: &str,
    pr: &GithubPullRequest,
) -> Result<()> {
    // The conflict target repeats the predicate of the v28 partial index verbatim; SQLite only
    // matches a partial unique index when the ON CONFLICT clause restates it.
    let ref_id: i64 = conn.query_row(
        "INSERT INTO external_refs (task_id, provider, ref_type, repo, number, url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(task_id, ref_type, repo, number)
           WHERE ref_type = 'pull_request'
             AND repo IS NOT NULL
             AND number IS NOT NULL
           DO UPDATE SET url = excluded.url
         RETURNING id",
        params![
            task_id,
            Provider::Github.as_str(),
            RefType::PullRequest.as_str(),
            &pr.repo,
            pr.number,
            &pr.url
        ],
        |row| row.get(0),
    )?;
    upsert_pr_ref_state_success(conn, ref_id, pr.status.as_str())
}

fn upsert_pr_ref_state_success(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
    status: &str,
) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO github_pull_request_ref_states
               (external_ref_id, status, updated_at)
             VALUES (?1, ?2, {SET_NOW})
             ON CONFLICT(external_ref_id) DO UPDATE SET
               status = excluded.status,
               updated_at = {SET_NOW}"
        ),
        params![external_ref_id, status],
    )?;
    Ok(())
}
