mod events;
mod external_refs;
mod projects;
mod runs;
#[cfg(test)]
mod tests;
mod work_items;

pub(super) const WORK_ITEM_COLUMNS: &str = "id, kind, status, phase, title, body, project_id,      labels, details_json, source_json, created_at, updated_at";

pub(super) const RUN_COLUMNS: &str = "id, work_item_id, agent, branch, worktree_path, status,      settings_path, created_at, updated_at";

pub(super) const PROJECT_COLUMNS: &str = "id, name, provider, repo, path, default_branch, worktree_root,      setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude,      created_at, updated_at";

pub(super) const EVENT_COLUMNS: &str = "id, work_item_id, run_id, kind, payload_json, created_at";

pub(super) const SET_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
