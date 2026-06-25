use anyhow::Result;
use monica_core::{
    Agent, Event, ExternalRef, PermissionMode, Project, Provider, RefType, Task, TaskKind, TaskRun,
    TaskRunStatus, TaskStatus,
};
use rusqlite::Row;

pub(super) fn task_from_row(row: &Row<'_>) -> Result<Task> {
    let labels: String = row.get("labels")?;
    let details: String = row.get("details_json")?;
    let source: Option<String> = row.get("source_json")?;
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    Ok(Task {
        id: row.get("id")?,
        kind: kind.parse::<TaskKind>()?,
        status: status.parse::<TaskStatus>()?,
        phase: row.get("phase")?,
        title: row.get("title")?,
        body: row.get("body")?,
        project_id: row.get("project_id")?,
        labels: serde_json::from_str(&labels)?,
        details: serde_json::from_str(&details)?,
        source: match source {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        },
        primary_task_run_id: row.get("primary_task_run_id")?,
        closed_at: row.get("closed_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(super) fn task_run_from_row(row: &Row<'_>) -> Result<TaskRun> {
    let status: String = row.get("status")?;
    let wait_reason: Option<String> = row.get("wait_reason")?;
    let agent: Option<String> = row.get("agent")?;
    let metadata: String = row.get("metadata_json")?;
    Ok(TaskRun {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        agent: agent.map(|s| s.parse::<Agent>()).transpose()?,
        branch: row.get("branch")?,
        worktree_path: row.get("worktree_path")?,
        status: status.parse::<TaskRunStatus>()?,
        wait_reason: wait_reason.map(|s| s.parse()).transpose()?,
        settings_path: row.get("settings_path")?,
        provider_session_id: row.get("provider_session_id")?,
        terminal_tab_id: row.get("terminal_tab_id")?,
        last_event_name: row.get("last_event_name")?,
        last_event_at: row.get("last_event_at")?,
        plan_file_path: row.get("plan_file_path")?,
        pending_stop: row.get::<_, i64>("pending_stop")? != 0,
        metadata: serde_json::from_str(&metadata)?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(super) fn event_from_row(row: &Row<'_>) -> Result<Event> {
    let payload: String = row.get("payload_json")?;
    Ok(Event {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        task_run_id: row.get("task_run_id")?,
        kind: row.get("kind")?,
        payload: serde_json::from_str(&payload)?,
        created_at: row.get("created_at")?,
    })
}

pub(super) fn external_ref_from_row(row: &Row<'_>) -> Result<ExternalRef> {
    let ref_type: String = row.get("ref_type")?;
    Ok(ExternalRef {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        ref_type: ref_type.parse::<RefType>()?,
        repo: row.get("repo")?,
        number: row.get("number")?,
        url: row.get("url")?,
        created_at: row.get("created_at")?,
    })
}

pub(super) fn project_from_row(row: &Row<'_>) -> Result<Project> {
    let provider: String = row.get("provider")?;
    let agent_default: String = row.get("agent_default")?;
    let agent_permission_mode: String = row.get("agent_permission_mode")?;
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        provider: provider.parse::<Provider>()?,
        repo: row.get("repo")?,
        path: row.get("path")?,
        default_branch: row.get("default_branch")?,
        worktree_root: row.get("worktree_root")?,
        setup_timeout_sec: row.get("setup_timeout_sec")?,
        agent_default: agent_default.parse::<Agent>()?,
        agent_permission_mode: agent_permission_mode.parse::<PermissionMode>()?,
        hooks_claude: row.get::<_, i64>("hooks_claude")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
