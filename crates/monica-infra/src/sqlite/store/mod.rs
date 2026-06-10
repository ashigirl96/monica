mod bench;
mod events;
mod external_refs;
mod projects;
mod pull_request_sync;
mod task_runs;
mod tasks;
pub(crate) mod terminal;

pub(super) const TASK_COLUMNS: &str = "id, kind, status, phase, title, body, project_id,      labels, details_json, source_json, primary_task_run_id, deleted_at, created_at, updated_at";

pub(super) const TASK_RUN_COLUMNS: &str =
    "id, task_id, agent, branch, worktree_path, status, wait_reason,      settings_path, provider_session_id, terminal_tab_id, last_event_name, last_event_at, metadata_json,      created_at, updated_at";

pub(super) const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root,      setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude,      created_at, updated_at";

pub(super) const EVENT_COLUMNS: &str = "id, task_id, task_run_id, kind, payload_json, created_at";

pub(super) const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
