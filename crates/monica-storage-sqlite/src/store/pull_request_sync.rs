use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::SqliteStore;
use monica_application::{
    GithubPullRequest, PullRequestBranchSyncCandidate, PullRequestStatusSyncCandidate,
    PullRequestSyncStore,
};
use monica_domain::{Provider, RefType};

use super::SET_NOW;

const PR_SYNC_RETRY_DELAY: &str = "+5 minutes";
const PR_STATUS_REFRESH_DELAY: &str = "-5 minutes";
const PR_BRANCH_EMPTY_REFRESH_DELAY: &str = "+60 seconds";
const PR_BRANCH_OPEN_REFRESH_DELAY: &str = "+60 seconds";
const PR_BRANCH_TERMINAL_REFRESH_DELAY: &str = "+15 minutes";
const PR_BRANCH_FAILURE_RETRY_DELAY: &str = "+5 minutes";

// The latest run's branch per development task, joined to its project repo. Shared by the periodic
// single-candidate query and the forced bulk query so branch eligibility lives in one place.
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
    pub fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>> {
        let mut stmt = self.conn().prepare(&format!(
            "{BRANCH_CANDIDATE_FROM}
             LEFT JOIN github_pull_request_branch_syncs sync
               ON sync.task_id = t.id
              AND sync.repo = project.repo
              AND sync.branch = latest_run.branch
             WHERE {BRANCH_CANDIDATE_WHERE}
               AND (
                 sync.task_id IS NULL
                 OR sync.next_retry_at IS NULL
                 OR sync.next_retry_at <= {SET_NOW}
               )
             ORDER BY COALESCE(sync.next_retry_at, latest_run.created_at, t.created_at),
                      latest_run.created_at,
                      t.id
             LIMIT 1",
        ))?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(PullRequestBranchSyncCandidate {
                task_id: row.get("task_id")?,
                repo: row.get("repo")?,
                branch: row.get("branch")?,
            })),
            None => Ok(None),
        }
    }

    pub fn next_pull_request_status_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestStatusSyncCandidate>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT
               pr.id AS external_ref_id,
               pr.task_id AS task_id,
               pr.repo AS repo,
               pr.number AS number
             FROM external_refs pr
             JOIN tasks t
               ON t.id = pr.task_id
             LEFT JOIN github_pull_request_ref_states state
               ON state.external_ref_id = pr.id
             WHERE pr.ref_type = 'pull_request'
               AND pr.repo IS NOT NULL
               AND pr.number IS NOT NULL
               AND pr.number > 0
               AND state.external_ref_id IS NOT NULL
               AND (state.next_retry_at IS NULL OR state.next_retry_at <= {SET_NOW})
               AND state.status IN ('draft', 'open')
               AND (
                 state.synced_at IS NULL
                 OR state.synced_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','{PR_STATUS_REFRESH_DELAY}')
                 )
             ORDER BY COALESCE(state.next_retry_at, state.synced_at, pr.created_at), pr.id
             LIMIT 1",
        ))?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(PullRequestStatusSyncCandidate {
                task_id: row.get("task_id")?,
                external_ref_id: row.get("external_ref_id")?,
                repo: row.get("repo")?,
                number: row.get("number")?,
            })),
            None => Ok(None),
        }
    }

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

    pub fn record_pull_request_branch_sync_success(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        write_branch_sync_success(&tx, candidate, pull_requests)?;
        tx.commit()?;
        Ok(())
    }

    pub fn bulk_record_branch_sync_success(
        &mut self,
        entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        for (candidate, pull_requests) in entries {
            write_branch_sync_success(&tx, candidate, pull_requests)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_pull_request_branch_sync_failure(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        error: &str,
    ) -> Result<()> {
        self.conn_mut().execute(
            &format!(
                "INSERT INTO github_pull_request_branch_syncs
                   (task_id, repo, branch, last_synced_at, last_error, next_retry_at, updated_at)
                 VALUES (
                   ?1, ?2, ?3, NULL, ?4,
                   strftime('%Y-%m-%dT%H:%M:%fZ','now','{PR_BRANCH_FAILURE_RETRY_DELAY}'), {SET_NOW}
                 )
                 ON CONFLICT(task_id, repo, branch) DO UPDATE SET
                   last_error = excluded.last_error,
                   next_retry_at = excluded.next_retry_at,
                   updated_at = {SET_NOW}"
            ),
            params![
                &candidate.task_id,
                &candidate.repo,
                &candidate.branch,
                error
            ],
        )?;
        Ok(())
    }

    pub fn record_pull_request_status_sync_success(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        pull_request: &GithubPullRequest,
    ) -> Result<()> {
        self.conn_mut().execute(
            "UPDATE external_refs
                SET url = ?1
              WHERE id = ?2",
            params![&pull_request.url, candidate.external_ref_id],
        )?;
        upsert_pr_ref_state_success(
            self.conn_mut(),
            candidate.external_ref_id,
            pull_request.status.as_str(),
        )?;
        Ok(())
    }

    pub fn record_pull_request_status_sync_failure(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        error: &str,
    ) -> Result<()> {
        self.conn_mut().execute(
            &format!(
                "INSERT INTO github_pull_request_ref_states
                   (external_ref_id, status, synced_at, last_error, next_retry_at, updated_at)
                 VALUES (
                   ?1, NULL, NULL, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now','{PR_SYNC_RETRY_DELAY}'), {SET_NOW}
                 )
                 ON CONFLICT(external_ref_id) DO UPDATE SET
                   last_error = excluded.last_error,
                   next_retry_at = excluded.next_retry_at,
                   updated_at = {SET_NOW}"
            ),
            params![candidate.external_ref_id, error],
        )?;
        Ok(())
    }

    pub fn force_clear_pr_sync_state(&mut self) -> Result<()> {
        // cmd+r asks to refresh PR *statuses* (open→merged/closed), not to re-discover branches.
        // Branch sync has strict priority over status sync in sync_next_pull_request, so resetting
        // every branch's next_retry_at here would refill the forced batch budget with branch
        // discovery and starve the status sync that actually flips a merged PR. Only the open/draft
        // ref states are made immediately eligible; branches keep their normal retry schedule, and
        // an undiscovered PR is still picked up by the regular branch candidate (missing sync row).
        self.conn_mut().execute(
            "UPDATE github_pull_request_ref_states
             SET next_retry_at = NULL, synced_at = NULL
             WHERE status IN ('draft', 'open') OR status IS NULL",
            [],
        )?;
        Ok(())
    }
}

// PR sync delegates to the inherent methods above; a trait impl cannot span files, so the SQL
// lives here with its tables while [`SqliteStore`] also exposes them inherently.
impl PullRequestSyncStore for SqliteStore {
    fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>> {
        SqliteStore::next_pull_request_branch_sync_candidate(self)
    }

    fn next_pull_request_status_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestStatusSyncCandidate>> {
        SqliteStore::next_pull_request_status_sync_candidate(self)
    }

    fn all_branch_sync_candidates(&self) -> Result<Vec<PullRequestBranchSyncCandidate>> {
        SqliteStore::all_branch_sync_candidates(self)
    }

    fn record_pull_request_branch_sync_success(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        SqliteStore::record_pull_request_branch_sync_success(self, candidate, pull_requests)
    }

    fn bulk_record_branch_sync_success(
        &mut self,
        entries: &[(PullRequestBranchSyncCandidate, Vec<GithubPullRequest>)],
    ) -> Result<()> {
        SqliteStore::bulk_record_branch_sync_success(self, entries)
    }

    fn record_pull_request_branch_sync_failure(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        error: &str,
    ) -> Result<()> {
        SqliteStore::record_pull_request_branch_sync_failure(self, candidate, error)
    }

    fn record_pull_request_status_sync_success(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        pull_request: &GithubPullRequest,
    ) -> Result<()> {
        SqliteStore::record_pull_request_status_sync_success(self, candidate, pull_request)
    }

    fn record_pull_request_status_sync_failure(
        &mut self,
        candidate: &PullRequestStatusSyncCandidate,
        error: &str,
    ) -> Result<()> {
        SqliteStore::record_pull_request_status_sync_failure(self, candidate, error)
    }

    fn force_clear_pr_sync_state(&mut self) -> Result<()> {
        SqliteStore::force_clear_pr_sync_state(self)
    }
}

fn write_branch_sync_success(
    tx: &rusqlite::Transaction,
    candidate: &PullRequestBranchSyncCandidate,
    pull_requests: &[GithubPullRequest],
) -> Result<()> {
    let retry_delay = branch_success_retry_delay(pull_requests);
    for pr in pull_requests {
        let existing = tx
            .query_row(
                "SELECT id
                 FROM external_refs
                 WHERE task_id = ?1
                   AND ref_type = ?2
                   AND repo = ?3
                   AND number = ?4
                 LIMIT 1",
                params![
                    &candidate.task_id,
                    RefType::PullRequest.as_str(),
                    &pr.repo,
                    pr.number
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let ref_id = if let Some(id) = existing {
            tx.execute(
                "UPDATE external_refs
                    SET url = ?1
                  WHERE id = ?2",
                params![&pr.url, id],
            )?;
            id
        } else {
            tx.execute(
                "INSERT INTO external_refs (task_id, provider, ref_type, repo, number, url)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &candidate.task_id,
                    Provider::Github.as_str(),
                    RefType::PullRequest.as_str(),
                    &pr.repo,
                    pr.number,
                    &pr.url
                ],
            )?;
            tx.last_insert_rowid()
        };
        upsert_pr_ref_state_success(tx, ref_id, pr.status.as_str())?;
    }
    tx.execute(
        &format!(
            "INSERT INTO github_pull_request_branch_syncs
               (task_id, repo, branch, last_synced_at, last_error, next_retry_at, updated_at)
             VALUES (
               ?1, ?2, ?3, {SET_NOW}, NULL,
               strftime('%Y-%m-%dT%H:%M:%fZ','now','{retry_delay}'), {SET_NOW}
             )
             ON CONFLICT(task_id, repo, branch) DO UPDATE SET
               last_synced_at = {SET_NOW},
               last_error = NULL,
               next_retry_at = excluded.next_retry_at,
               updated_at = {SET_NOW}"
        ),
        params![&candidate.task_id, &candidate.repo, &candidate.branch],
    )?;
    Ok(())
}

fn upsert_pr_ref_state_success(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
    status: &str,
) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO github_pull_request_ref_states
               (external_ref_id, status, synced_at, last_error, next_retry_at, updated_at)
             VALUES (?1, ?2, {SET_NOW}, NULL, NULL, {SET_NOW})
             ON CONFLICT(external_ref_id) DO UPDATE SET
               status = excluded.status,
               synced_at = {SET_NOW},
               last_error = NULL,
               next_retry_at = NULL,
               updated_at = {SET_NOW}"
        ),
        params![external_ref_id, status],
    )?;
    Ok(())
}

fn branch_success_retry_delay(pull_requests: &[GithubPullRequest]) -> &'static str {
    if pull_requests.is_empty() {
        return PR_BRANCH_EMPTY_REFRESH_DELAY;
    }
    if pull_requests.iter().any(|pr| pr.status.is_open_or_draft()) {
        PR_BRANCH_OPEN_REFRESH_DELAY
    } else {
        PR_BRANCH_TERMINAL_REFRESH_DELAY
    }
}
