use std::str::FromStr;

use anyhow::Result;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::SqliteStore;
use monica_application::{
    FieldChange, GithubPullRequest, GithubPullRequestStatus, PullRequestBranchSyncCandidate,
    PullRequestSyncChange, PullRequestSyncStore, UnresolvedPullRequestRef,
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
    ) -> Result<Vec<PullRequestSyncChange>> {
        // Immediate: both passes read a row before writing it, and a DEFERRED transaction that
        // starts with a read gets SQLITE_BUSY without consulting the busy handler when it later
        // tries to upgrade to a write lock. Same reason as `get_or_create_daily_note`.
        let tx = self
            .conn_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut changes = Vec::new();
        for (candidate, pull_requests) in branch_entries {
            changes.extend(write_branch_sync_success(&tx, candidate, pull_requests)?);
        }
        for (unresolved_ref, pull_request) in status_entries {
            tx.execute(
                "UPDATE external_refs
                    SET url = ?1
                  WHERE id = ?2",
                params![&pull_request.url, unresolved_ref.external_ref_id],
            )?;
            let previous = read_pr_ref_status(&tx, unresolved_ref.external_ref_id)?;
            upsert_pr_ref_state_success(
                &tx,
                unresolved_ref.external_ref_id,
                pull_request.status.as_str(),
            )?;
            if let Some(status) = FieldChange::detect(previous, pull_request.status) {
                changes.push(PullRequestSyncChange {
                    task_id: unresolved_ref.task_id.clone(),
                    repo: pull_request.repo.clone(),
                    number: pull_request.number,
                    status: Some(status),
                    newly_linked: false,
                });
            }
        }
        tx.commit()?;
        Ok(changes)
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
    ) -> Result<Vec<PullRequestSyncChange>> {
        SqliteStore::bulk_record_pr_sync(self, branch_entries, status_entries)
    }
}

fn write_branch_sync_success(
    tx: &rusqlite::Transaction,
    candidate: &PullRequestBranchSyncCandidate,
    pull_requests: &[GithubPullRequest],
) -> Result<Vec<PullRequestSyncChange>> {
    let mut changes = Vec::new();
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
        let newly_linked = existing.is_none();
        let previous = read_pr_ref_status(tx, ref_id)?;
        upsert_pr_ref_state_success(tx, ref_id, pr.status.as_str())?;
        let status = FieldChange::detect(previous, pr.status);
        if newly_linked || status.is_some() {
            changes.push(PullRequestSyncChange {
                task_id: candidate.task_id.clone(),
                repo: pr.repo.clone(),
                number: pr.number,
                status,
                newly_linked,
            });
        }
    }
    Ok(changes)
}

/// The cached status, `None` when no state row exists yet or the column was never filled.
fn read_pr_ref_status(
    conn: &rusqlite::Connection,
    external_ref_id: i64,
) -> Result<Option<GithubPullRequestStatus>> {
    let status: Option<Option<String>> = conn
        .query_row(
            "SELECT status FROM github_pull_request_ref_states WHERE external_ref_id = ?1",
            params![external_ref_id],
            |row| row.get("status"),
        )
        .optional()?;
    Ok(status
        .flatten()
        .and_then(|s| GithubPullRequestStatus::from_str(&s).ok()))
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
