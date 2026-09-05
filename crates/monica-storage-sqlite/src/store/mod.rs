mod bench;
mod events;
mod explanations;
mod external_refs;
mod github_issue_sync;
pub(crate) mod notes;
pub(crate) mod notification_outbox;
mod projects;
mod pull_request_sync;
mod task_runs;
mod tasks;
pub(crate) mod terminal;
mod terminal_sessions;
mod unit_of_work;

/// Task columns as read through [`TASK_FROM`]. `title` resolves against the issue-ref cache so a
/// task backed by a GitHub issue shows what GitHub currently says, falling back to the column for
/// rows tracked before the cache existed and to `''` when neither is set.
pub(super) const TASK_COLUMNS: &str = "t.id, t.kind, t.status, t.phase,      COALESCE(issue_state.title, t.title, '') AS title, COALESCE(t.body, '') AS body,      t.project_id, t.labels, t.details_json, t.source_json, t.primary_task_run_id, t.closed_at,      t.created_at, t.updated_at";

/// The task table joined to its newest issue ref and that ref's cached state. Every read of
/// [`TASK_COLUMNS`] goes through this so the two can't drift.
pub(super) const TASK_FROM: &str = "tasks t      LEFT JOIN external_refs issue_ref ON issue_ref.id = (        SELECT er.id FROM external_refs er        WHERE er.task_id = t.id AND er.ref_type = 'issue'        ORDER BY er.id DESC LIMIT 1)      LEFT JOIN github_issue_ref_states issue_state ON issue_state.external_ref_id = issue_ref.id";

pub(super) const TASK_RUN_COLUMNS: &str =
    "id, task_id, agent, branch, worktree_path, status, wait_reason,      agent_session_id, terminal_tab_id, last_event_name, last_event_at, plan_file_path, pending_stop, metadata_json,      created_at, updated_at";

pub(super) const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root,      setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude,      primary_note_id, created_at, updated_at";

pub(super) const EVENT_COLUMNS: &str = "id, task_id, task_run_id, kind, payload_json, created_at";

pub(super) const NOTIFICATION_OUTBOX_COLUMNS: &str =
    "id, dedupe_key, kind, title, body, task_id, task_run_id, created_at, delivered_at, error, attempts";

pub(super) const EXPLANATION_COLUMNS: &str =
    "e.id, e.title, e.summary, e.mode, e.agent_session_id, e.terminal_session_id, e.created_at, e.repo_name, ts.cwd";

pub(super) const EXPLANATION_FROM: &str =
    "explanations e LEFT JOIN terminal_sessions ts ON e.terminal_session_id = ts.id";

pub(super) const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

pub(super) const NOTE_COLUMNS: &str =
    "id, title, kind, project_id, status, content, date, created_at, updated_at";

/// Render enum tokens as a quoted SQL IN-list. Callers pass compile-time `as_str` constants,
/// so no escaping is needed.
pub(super) fn sql_literal_list<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .map(|v| format!("'{v}'"))
        .collect::<Vec<_>>()
        .join(", ")
}
