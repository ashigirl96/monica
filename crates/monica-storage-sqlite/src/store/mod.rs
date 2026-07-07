mod bench;
mod events;
mod external_refs;
pub(crate) mod notification_outbox;
mod projects;
mod pull_request_sync;
mod task_runs;
mod tasks;
pub(crate) mod terminal;
mod terminal_sessions;
mod unit_of_work;

pub(super) const TASK_COLUMNS: &str = "id, kind, status, phase, title, body, project_id,      labels, details_json, source_json, primary_task_run_id, closed_at, created_at, updated_at";

pub(super) const TASK_RUN_COLUMNS: &str =
    "id, task_id, agent, branch, worktree_path, status, wait_reason,      settings_path, provider_session_id, terminal_tab_id, last_event_name, last_event_at, plan_file_path, pending_stop, metadata_json,      created_at, updated_at";

pub(super) const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root,      setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude,      created_at, updated_at";

pub(super) const EVENT_COLUMNS: &str = "id, task_id, task_run_id, kind, payload_json, created_at";

pub(super) const NOTIFICATION_OUTBOX_COLUMNS: &str =
    "id, dedupe_key, kind, title, body, task_id, task_run_id, created_at, delivered_at, error, attempts";

pub(super) const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// Render enum tokens as a quoted SQL IN-list. Callers pass compile-time `as_str` constants,
/// so no escaping is needed.
pub(super) fn sql_literal_list<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .map(|v| format!("'{v}'"))
        .collect::<Vec<_>>()
        .join(", ")
}
