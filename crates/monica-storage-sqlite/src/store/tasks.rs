use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::SqliteStore;
use monica_application::{
    GithubIssueState, GithubPullRequestStatus, TaskBoardQuery, TaskStore, TaskSummaryFilter,
    TaskSummaryRow,
};
use monica_domain::{
    DisplayStatus, ExternalReference, NewTask, Provider, RefType, Task, TaskId, TaskRunId,
    TaskRunStatus, TaskRunWaitReason, TaskStatus,
};

use super::{external_refs, sql_literal_list, SET_NOW, TASK_COLUMNS, TASK_FROM};

pub(super) fn insert_task_in(
    conn: &Connection,
    new: NewTask,
    external: Option<ExternalReference>,
) -> Result<Task> {
    let labels = serde_json::to_string(&new.labels)?;
    let details = new.details.into_string();
    let source = new.source.map(|v| v.into_string());

    conn.execute("INSERT INTO mon_counter DEFAULT VALUES", [])?;
    let id = format!("MON-{}", conn.last_insert_rowid());
    conn.execute(
        "INSERT INTO tasks
           (id, kind, status, phase, title, body, project_id, labels, details_json, source_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            new.kind.as_str(),
            new.status.as_str(),
            new.phase,
            new.title,
            new.body,
            new.project_id,
            labels,
            details,
            source,
        ],
    )?;

    if let Some(external) = external {
        conn.execute(
            "INSERT INTO external_refs (task_id, provider, ref_type, repo, number, url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                external.provider.as_str(),
                external.ref_type.as_str(),
                external.repo,
                external.number,
                external.url
            ],
        )?;
    }

    let mut stmt = conn.prepare(&format!("SELECT {TASK_COLUMNS} FROM {TASK_FROM} WHERE t.id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(crate::row::task_from_row(row)?),
        None => Err(anyhow!("inserted task {id} not found")),
    }
}

pub(super) fn get_task(conn: &Connection, id: &TaskId) -> Result<Option<Task>> {
    let mut stmt = conn.prepare(&format!("SELECT {TASK_COLUMNS} FROM {TASK_FROM} WHERE t.id = ?1"))?;
    let mut rows = stmt.query(params![id.as_str()])?;
    match rows.next()? {
        Some(row) => Ok(Some(crate::row::task_from_row(row)?)),
        None => Ok(None),
    }
}

/// Picks the newest open task tracking one external ref. Shared by the full-row and the id-only
/// lookup so the rule can't drift between them. `MON-<n>` sorts wrong as text (MON-10 < MON-9), so
/// the created_at tie-break casts the counter part to an integer — the same shape the summary
/// query uses for the latest run.
const NEWEST_OPEN_TASK_FOR_REF: &str = "
          WHERE t.status != ?1
            AND t.id IN (SELECT task_id FROM external_refs
                          WHERE provider = ?2 AND ref_type = ?3 AND repo = ?4 AND number = ?5)
          ORDER BY t.created_at DESC, CAST(SUBSTR(t.id, 5) AS INTEGER) DESC
          LIMIT 1";

pub(super) fn find_open_task_by_external_ref_in(
    conn: &Connection,
    provider: Provider,
    ref_type: RefType,
    repo: &str,
    number: i64,
) -> Result<Option<Task>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_COLUMNS} FROM {TASK_FROM}{NEWEST_OPEN_TASK_FOR_REF}"
    ))?;
    let mut rows = stmt.query(params![
        TaskStatus::Closed.as_str(),
        provider.as_str(),
        ref_type.as_str(),
        repo,
        number
    ])?;
    match rows.next()? {
        Some(row) => Ok(Some(crate::row::task_from_row(row)?)),
        None => Ok(None),
    }
}

/// The same lookup for callers that only need the id — the issue sync resolving a parent link, for
/// one. Reading it through [`find_open_task_by_external_ref_in`] would hydrate a whole task (two
/// joins plus the JSON and enum columns) on every synced issue just to throw all of it away.
pub(super) fn find_open_task_id_by_external_ref_in(
    conn: &Connection,
    provider: Provider,
    ref_type: RefType,
    repo: &str,
    number: i64,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            &format!("SELECT t.id FROM tasks t{NEWEST_OPEN_TASK_FOR_REF}"),
            params![
                TaskStatus::Closed.as_str(),
                provider.as_str(),
                ref_type.as_str(),
                repo,
                number
            ],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn mark_task_closed_in(conn: &Connection, id: &TaskId) -> Result<Task> {
    let affected = conn.execute(
        &format!(
            "UPDATE tasks
                SET status = 'closed',
                    closed_at = {SET_NOW},
                    updated_at = {SET_NOW}
              WHERE id = ?1"
        ),
        params![id.as_str()],
    )?;
    if affected == 0 {
        return Err(anyhow!("task not found: {id}"));
    }
    // A closed task is no longer a parent, so drop the links pointing at it now rather than
    // waiting for the next GitHub sync to re-resolve them. Children that are themselves closed
    // keep theirs: their whole GitHub cache is frozen at what it was while they were open.
    conn.execute(
        "UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?1 AND status != 'closed'",
        params![id.as_str()],
    )?;
    let mut stmt = conn.prepare(&format!("SELECT {TASK_COLUMNS} FROM {TASK_FROM} WHERE t.id = ?1"))?;
    let mut rows = stmt.query(params![id.as_str()])?;
    match rows.next()? {
        Some(row) => Ok(crate::row::task_from_row(row)?),
        None => Err(anyhow!("task not found: {id}")),
    }
}

pub(super) fn list_tasks(conn: &Connection) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_COLUMNS} FROM {TASK_FROM}
         ORDER BY t.created_at, t.id"
    ))?;
    let mut rows = stmt.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push(crate::row::task_from_row(row)?);
    }
    Ok(items)
}

pub(super) fn set_primary_task_run(
    conn: &Connection,
    task_id: &TaskId,
    task_run_id: &TaskRunId,
) -> Result<()> {
    let affected = conn.execute(
        &format!(
            "UPDATE tasks SET primary_task_run_id = ?1, updated_at = {SET_NOW}
             WHERE id = ?2"
        ),
        params![task_run_id.as_str(), task_id.as_str()],
    )?;
    if affected == 0 {
        return Err(anyhow!("task not found: {task_id}"));
    }
    Ok(())
}

pub(super) fn update_task_status(conn: &Connection, id: &TaskId, status: TaskStatus) -> Result<()> {
    let affected = conn.execute(
        &format!(
            "UPDATE tasks
               SET status = ?1, updated_at = {SET_NOW}
             WHERE id = ?2"
        ),
        params![status.as_str(), id.as_str()],
    )?;
    if affected == 0 {
        return Err(anyhow!("task not found: {id}"));
    }
    Ok(())
}

pub(super) fn mark_task_in(
    conn: &Connection,
    id: &TaskId,
    status: TaskStatus,
    note: Option<&str>,
) -> Result<()> {
    let status_str = status.as_str();
    let payload = serde_json::to_string(&serde_json::json!({
        "status": status_str,
        "note": note,
    }))?;

    let affected = conn.execute(
        &format!(
            "UPDATE tasks
                   SET status = ?1, phase = COALESCE(?2, phase), updated_at = {SET_NOW}
                 WHERE id = ?3"
        ),
        params![status_str, note, id.as_str()],
    )?;
    if affected == 0 {
        return Err(anyhow!("task not found: {id}"));
    }
    conn.execute(
        "INSERT INTO events (task_id, kind, payload_json) VALUES (?1, 'mark', ?2)",
        params![id.as_str(), payload],
    )?;
    Ok(())
}

impl TaskStore for SqliteStore {
    fn insert_task(&mut self, new: NewTask) -> Result<Task> {
        let tx = self.conn_mut().transaction()?;
        let item = insert_task_in(&tx, new, None)?;
        tx.commit()?;
        Ok(item)
    }

    /// Insert a task and its external ref in one transaction, so a failure to record the
    /// external link can never leave an orphan task behind. The ref's `task_id` is
    /// replaced with the freshly allocated `MON-<n>` id.
    fn insert_task_with_ref(&mut self, new: NewTask, external: ExternalReference) -> Result<Task> {
        let tx = self.conn_mut().transaction()?;
        let item = insert_task_in(&tx, new, Some(external))?;
        tx.commit()?;
        Ok(item)
    }

    fn get_task(&self, id: &TaskId) -> Result<Option<Task>> {
        get_task(self.conn(), id)
    }

    fn mark_task_closed(&mut self, id: &TaskId) -> Result<Task> {
        let tx = self.conn_mut().transaction()?;
        let item = mark_task_closed_in(&tx, id)?;
        tx.commit()?;
        Ok(item)
    }

    fn list_tasks(&self) -> Result<Vec<Task>> {
        list_tasks(self.conn())
    }

    fn set_primary_task_run(&self, task_id: &TaskId, task_run_id: &TaskRunId) -> Result<()> {
        set_primary_task_run(self.conn(), task_id, task_run_id)
    }

    fn update_task_status(&self, id: &TaskId, status: TaskStatus) -> Result<()> {
        update_task_status(self.conn(), id, status)
    }

    fn mark_task(&mut self, id: &TaskId, status: TaskStatus, note: Option<&str>) -> Result<()> {
        let tx = self.conn_mut().transaction()?;
        mark_task_in(&tx, id, status, note)?;
        tx.commit()?;
        Ok(())
    }

    fn list_external_refs(&self, task_id: &TaskId) -> Result<Vec<ExternalReference>> {
        external_refs::list_external_refs(self.conn(), task_id)
    }

    fn find_open_task_by_external_ref(
        &self,
        provider: Provider,
        ref_type: RefType,
        repo: &str,
        number: i64,
    ) -> Result<Option<Task>> {
        find_open_task_by_external_ref_in(self.conn(), provider, ref_type, repo, number)
    }
}

impl TaskBoardQuery for SqliteStore {
    fn list_task_summaries(
        &self,
        filter: TaskSummaryFilter,
        project: Option<&str>,
    ) -> Result<Vec<TaskSummaryRow>> {
        let tool_waits =
            sql_literal_list(TaskRunWaitReason::TOOL_WAITS.iter().map(|r| r.as_str()));
        let mut stmt = self.conn().prepare(&format!(
            "SELECT
               t.id AS task_id,
               t.parent_task_id AS parent_task_id,
               COALESCE(issue_state.title, t.title, '') AS title,
               coalesce(project.repo, issue_ref.repo, t.project_id) AS project,
               issue_ref.number AS github_issue_number,
               issue_ref.url AS github_issue_url,
               issue_ref.repo AS github_issue_repo,
               issue_state.state AS github_issue_state,
	               t.status AS task_status,
	               latest_run.status AS task_run_status,
	               latest_run.wait_reason AS task_run_wait_reason,
	               latest_run.plan_file_path IS NOT NULL AS has_plan,
	               latest_run.agent_session_id IS NOT NULL AS primary_has_session,
	               latest_run.branch AS branch,
               (SELECT COUNT(*) FROM task_runs r
                 WHERE r.task_id = t.id AND r.id IS NOT latest_run.id
                   AND r.status = ?2) AS side_runs_running,
               -- only tool-blocked waits are attention items; a side run idling between turns
               -- (awaiting_prompt) is healthy and must not light up the board
               (SELECT COUNT(*) FROM task_runs r
                 WHERE r.task_id = t.id AND r.id IS NOT latest_run.id
                   AND r.status = ?3
                   AND r.wait_reason IN ({tool_waits})) AS side_runs_waiting_for_user,
               -- a run without a Claude session is an old prepare failure, not a side run
               (SELECT COUNT(*) FROM task_runs r
                 WHERE r.task_id = t.id AND r.id IS NOT latest_run.id
                   AND r.status = ?4
                   AND r.agent_session_id IS NOT NULL) AS side_runs_failed
	             FROM {TASK_FROM}
             LEFT JOIN projects project
               ON project.id = t.project_id
            -- resolve the primary pointer through an existence check: a dangling pointer must
            -- fall back to the latest run instead of matching nothing (which would also count
            -- every run as a side run via `r.id IS NOT latest_run.id`)
            LEFT JOIN task_runs latest_run
               ON latest_run.id = COALESCE(
                 (SELECT id FROM task_runs WHERE id = t.primary_task_run_id),
                 (
                   SELECT r.id
                   FROM task_runs r
                   WHERE r.task_id = t.id
                   ORDER BY r.created_at DESC,
                            CAST(SUBSTR(r.id, 5) AS INTEGER) DESC
                   LIMIT 1
                 )
               )
	             WHERE (?1 IS NULL OR coalesce(project.repo, issue_ref.repo, t.project_id) = ?1)
	             ORDER BY t.created_at, t.id"
        ))?;
        let mut rows = stmt.query(params![
            project,
            TaskRunStatus::Running.as_str(),
            TaskRunStatus::WaitingForUser.as_str(),
            TaskRunStatus::Failed.as_str()
        ])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            let task_status: TaskStatus = row.get::<_, String>("task_status")?.parse()?;
            let task_run_status: Option<TaskRunStatus> = row
                .get::<_, Option<String>>("task_run_status")?
                .map(|s| s.parse())
                .transpose()?;
            let task_run_wait_reason: Option<TaskRunWaitReason> = row
                .get::<_, Option<String>>("task_run_wait_reason")?
                .map(|s| s.parse())
                .transpose()?;
            let has_plan: bool = row.get::<_, i64>("has_plan")? != 0;
            let primary_has_session: bool = row.get::<_, i64>("primary_has_session")? != 0;
            let display_status = DisplayStatus::from_task_and_run(task_status, task_run_status);
            let github_issue_number: Option<i64> = row.get("github_issue_number")?;
            let github_issue_state: Option<GithubIssueState> = row
                .get::<_, Option<String>>("github_issue_state")?
                .map(|s| s.parse())
                .transpose()?;
            let github_issue_repo: Option<String> = row.get("github_issue_repo")?;
            // A tracked issue always carries a stored URL, but the column is nullable and
            // predates URL storage; synthesize from repo+number so the backend stays the sole
            // authority on the URL rather than leaking construction to the frontend.
            let github_issue_url: Option<String> =
                row.get::<_, Option<String>>("github_issue_url")?.or_else(|| {
                    match (github_issue_repo.as_deref(), github_issue_number) {
                        (Some(repo), Some(number)) => {
                            Some(monica_domain::github_issue_url(repo, number))
                        }
                        _ => None,
                    }
                });
            let item = TaskSummaryRow {
                id: row.get("task_id")?,
                parent_task_id: row.get("parent_task_id")?,
                title: row.get("title")?,
                project: row.get("project")?,
                github_issue_number,
                github_issue_url,
                github_issue_state,
                github_pull_requests: Vec::new(),
                task_status,
                task_run_status,
                task_run_wait_reason,
                has_plan,
                status: display_status,
                prepare_eligible: display_status.prepare_eligible(),
                run_eligible: display_status.run_eligible(),
                run_needs_prepare: display_status.run_needs_prepare(primary_has_session),
                attach_eligible: display_status.attach_eligible(),
                is_active: display_status.is_active(),
                has_open_pull_request: false,
                branch: row.get("branch")?,
                side_runs_running: row.get("side_runs_running")?,
                side_runs_waiting_for_user: row.get("side_runs_waiting_for_user")?,
                side_runs_failed: row.get("side_runs_failed")?,
            };
            if filter.matches(item.status) {
                items.push(item);
            }
        }
        for item in &mut items {
            item.github_pull_requests = self.list_github_pull_request_refs(&item.id)?;
            item.has_open_pull_request = item.github_pull_requests.iter().any(|pr| {
                pr.status
                    .as_deref()
                    .and_then(|s| s.parse::<GithubPullRequestStatus>().ok())
                    .is_some_and(GithubPullRequestStatus::is_open_or_draft)
            });
        }
        Ok(items)
    }
}
