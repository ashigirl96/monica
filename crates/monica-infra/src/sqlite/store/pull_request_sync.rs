use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::sqlite::SqliteStore;
use monica_core::{
    GithubPullRequest, GithubPullRequestStatus, PullRequestBranchSyncCandidate,
    PullRequestStatusSyncCandidate, PullRequestSyncCandidate, RefType,
};

use super::SET_NOW;

const PR_SYNC_RETRY_DELAY: &str = "+5 minutes";
const PR_EMPTY_REFRESH_DELAY: &str = "+5 minutes";
const PR_STATUS_REFRESH_DELAY: &str = "-5 minutes";
const PR_BRANCH_EMPTY_REFRESH_DELAY: &str = "+60 seconds";
const PR_BRANCH_OPEN_REFRESH_DELAY: &str = "+60 seconds";
const PR_BRANCH_TERMINAL_REFRESH_DELAY: &str = "+15 minutes";
const PR_BRANCH_FAILURE_RETRY_DELAY: &str = "+5 minutes";

impl SqliteStore {
    pub fn next_pull_request_branch_sync_candidate(
        &self,
    ) -> Result<Option<PullRequestBranchSyncCandidate>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT
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
                  ORDER BY r.created_at DESC,
                           CASE
                             WHEN r.id GLOB 'run-[0-9]*' THEN CAST(SUBSTR(r.id, 5) AS INTEGER)
                             ELSE -1
                           END DESC,
                           r.id DESC
                  LIMIT 1
               )
             LEFT JOIN github_pull_request_branch_syncs sync
               ON sync.task_id = t.id
              AND sync.repo = project.repo
              AND sync.branch = latest_run.branch
             WHERE t.deleted_at IS NULL
               AND t.kind = 'development'
               AND project.repo IS NOT NULL
               AND trim(project.repo) != ''
               AND latest_run.branch IS NOT NULL
               AND trim(latest_run.branch) != ''
               AND lower(trim(latest_run.branch)) NOT IN ('main', 'master')
               AND lower(trim(latest_run.branch)) != lower(trim(project.default_branch))
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

    pub fn next_pull_request_sync_candidate(&self) -> Result<Option<PullRequestSyncCandidate>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT
               t.id AS task_id,
               issue_ref.id AS source_ref_id,
               issue_ref.repo AS repo,
               issue_ref.number AS issue_number
             FROM tasks t
             JOIN external_refs issue_ref
               ON issue_ref.id = (
                 SELECT er.id
                   FROM external_refs er
                  WHERE er.task_id = t.id
                    AND er.ref_type = 'github_issue'
                  ORDER BY er.id DESC
                  LIMIT 1
               )
             LEFT JOIN external_ref_syncs sync
               ON sync.task_id = t.id
              AND sync.source_ref_id = issue_ref.id
              AND sync.target_ref_type = 'github_pull_request'
             WHERE t.deleted_at IS NULL
               AND t.kind = 'development'
               AND issue_ref.repo IS NOT NULL
               AND issue_ref.number IS NOT NULL
               AND issue_ref.number > 0
               AND (
                 sync.task_id IS NULL
                 OR (
                   sync.last_synced_at IS NULL
                   AND (sync.next_retry_at IS NULL OR sync.next_retry_at <= {SET_NOW})
                 )
               )
             ORDER BY COALESCE(sync.next_retry_at, t.created_at), t.created_at, t.id
             LIMIT 1",
        ))?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(PullRequestSyncCandidate {
                task_id: row.get("task_id")?,
                source_ref_id: row.get("source_ref_id")?,
                repo: row.get("repo")?,
                issue_number: row.get("issue_number")?,
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
             WHERE t.deleted_at IS NULL
               AND pr.ref_type = 'github_pull_request'
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

    pub fn record_pull_request_branch_sync_success(
        &mut self,
        candidate: &PullRequestBranchSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        let retry_delay = branch_success_retry_delay(pull_requests);
        let tx = self.conn_mut().transaction()?;
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
                        RefType::GithubPullRequest.as_str(),
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
                    "INSERT INTO external_refs (task_id, ref_type, repo, number, url)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        &candidate.task_id,
                        RefType::GithubPullRequest.as_str(),
                        &pr.repo,
                        pr.number,
                        &pr.url
                    ],
                )?;
                tx.last_insert_rowid()
            };
            tx.execute(
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
                params![ref_id, pr.status.as_str()],
            )?;
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

    pub fn record_pull_request_sync_success(
        &mut self,
        candidate: &PullRequestSyncCandidate,
        pull_requests: &[GithubPullRequest],
    ) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
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
                        RefType::GithubPullRequest.as_str(),
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
                    "INSERT INTO external_refs (task_id, ref_type, repo, number, url)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        &candidate.task_id,
                        RefType::GithubPullRequest.as_str(),
                        &pr.repo,
                        pr.number,
                        &pr.url
                    ],
                )?;
                tx.last_insert_rowid()
            };
            tx.execute(
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
                params![ref_id, pr.status.as_str()],
            )?;
        }
        if pull_requests.is_empty() {
            tx.execute(
                &format!(
                    "INSERT INTO external_ref_syncs
                       (task_id, source_ref_id, target_ref_type, last_synced_at, last_error,
                        next_retry_at, updated_at)
                     VALUES (
                       ?1, ?2, ?3, NULL, NULL,
                       strftime('%Y-%m-%dT%H:%M:%fZ','now','{PR_EMPTY_REFRESH_DELAY}'), {SET_NOW}
                     )
                     ON CONFLICT(task_id, source_ref_id, target_ref_type) DO UPDATE SET
                       last_synced_at = NULL,
                       last_error = NULL,
                       next_retry_at = excluded.next_retry_at,
                       updated_at = {SET_NOW}"
                ),
                params![
                    &candidate.task_id,
                    candidate.source_ref_id,
                    RefType::GithubPullRequest.as_str()
                ],
            )?;
        } else {
            tx.execute(
                &format!(
                    "INSERT INTO external_ref_syncs
                       (task_id, source_ref_id, target_ref_type, last_synced_at, last_error,
                        next_retry_at, updated_at)
                     VALUES (?1, ?2, ?3, {SET_NOW}, NULL, NULL, {SET_NOW})
                     ON CONFLICT(task_id, source_ref_id, target_ref_type) DO UPDATE SET
                       last_synced_at = {SET_NOW},
                       last_error = NULL,
                       next_retry_at = NULL,
                       updated_at = {SET_NOW}"
                ),
                params![
                    &candidate.task_id,
                    candidate.source_ref_id,
                    RefType::GithubPullRequest.as_str()
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_pull_request_sync_failure(
        &mut self,
        candidate: &PullRequestSyncCandidate,
        error: &str,
    ) -> Result<()> {
        self.conn_mut().execute(
            &format!(
                "INSERT INTO external_ref_syncs
                   (task_id, source_ref_id, target_ref_type, last_synced_at, last_error,
                    next_retry_at, updated_at)
                 VALUES (
                   ?1, ?2, ?3, NULL, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now','{PR_SYNC_RETRY_DELAY}'), {SET_NOW}
                 )
                 ON CONFLICT(task_id, source_ref_id, target_ref_type) DO UPDATE SET
                   last_synced_at = NULL,
                   last_error = excluded.last_error,
                   next_retry_at = excluded.next_retry_at,
                   updated_at = {SET_NOW}"
            ),
            params![
                &candidate.task_id,
                candidate.source_ref_id,
                RefType::GithubPullRequest.as_str(),
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
        self.conn_mut().execute(
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
            params![candidate.external_ref_id, pull_request.status.as_str()],
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
}

fn branch_success_retry_delay(pull_requests: &[GithubPullRequest]) -> &'static str {
    if pull_requests.is_empty() {
        return PR_BRANCH_EMPTY_REFRESH_DELAY;
    }
    if pull_requests.iter().any(|pr| {
        matches!(
            pr.status,
            GithubPullRequestStatus::Draft | GithubPullRequestStatus::Open
        )
    }) {
        PR_BRANCH_OPEN_REFRESH_DELAY
    } else {
        PR_BRANCH_TERMINAL_REFRESH_DELAY
    }
}
