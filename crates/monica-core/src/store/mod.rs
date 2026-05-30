mod agent_sessions;
mod events;
mod external_refs;
mod projects;
mod task_runs;
mod tasks;
#[cfg(test)]
mod tests;

pub(super) const TASK_COLUMNS: &str = "id, kind, status, phase, title, body, project_id,      labels, details_json, source_json, created_at, updated_at";

pub(super) const TASK_RUN_COLUMNS: &str =
    "id, task_id, agent, branch, worktree_path, status,      settings_path, created_at, updated_at";

pub(super) const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root,      setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude,      created_at, updated_at";

pub(super) const EVENT_COLUMNS: &str = "id, task_id, task_run_id, kind, payload_json, created_at";

pub(super) const AGENT_SESSION_COLUMNS: &str = "id, task_id, task_run_id, agent, mode, status,      provider_session_id, parent_session_id, last_event_name, last_event_at, metadata_json,      created_at, updated_at";

pub(super) const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
