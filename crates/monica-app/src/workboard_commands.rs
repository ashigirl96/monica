use anyhow::{anyhow, Context, Result};
use monica_core::{
    parse_issue_ref, parse_owner_repo, Agent, AgentLaunch, AgentLaunchMode, TaskRunStatus,
    TaskSummaryRow, TrackGithubIssueInput,
};
use monica_infra::Runtime;
use serde::Serialize;

use crate::pty_commands::{PtySpawnCommand, PtySpawnEnv};

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct WorkboardRunReport {
    pub task_id: String,
    pub task_run_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: TaskRunStatus,
    pub setup: String,
    pub log_path: String,
    pub settings_path: Option<String>,
    pub launch: Option<PtySpawnCommand>,
}

#[tauri::command]
#[specta::specta]
pub fn workboard_list_tasks(project: Option<String>) -> Result<Vec<TaskSummaryRow>, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let project = normalize_project_filter(project.as_deref()).map_err(|e| e.to_string())?;
    monica_core::list_task_summaries(&runtime.repositories, None, project.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn workboard_track_issue(target: String) -> Result<TaskSummaryRow, String> {
    let (repo, number) = parse_issue_target(&target).map_err(|e| e.to_string())?;
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let report = monica_core::track_github_issue(
        &mut runtime.repositories,
        &runtime.github,
        TrackGithubIssueInput {
            repo: repo.clone(),
            number,
        },
    )
    .await
    .with_context(|| format!("failed to fetch GitHub issue {repo}#{number}"))
    .map_err(|e| e.to_string())?;

    find_task_summary(&runtime, &report.task.id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn workboard_run_task(task_id: String) -> Result<WorkboardRunReport, String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    let report = monica_core::run_issue_with_launch_mode(
        &mut runtime.repositories,
        &runtime.git,
        &runtime.setup_runner,
        &runtime.run_artifacts,
        &task_id,
        Some(Agent::Claude),
        AgentLaunchMode::New,
    )
    .map_err(|e| e.to_string())?;

    Ok(WorkboardRunReport {
        task_id: report.task_id,
        task_run_id: report.task_run_id,
        branch: report.branch,
        worktree_path: report.worktree_path,
        status: report.status,
        setup: describe_setup(&report.setup),
        log_path: report.log_path,
        settings_path: report.settings_path,
        launch: report.agent_launch.map(agent_launch_to_pty),
    })
}

fn normalize_project_filter(project: Option<&str>) -> Result<Option<String>> {
    project
        .map(str::trim)
        .filter(|project| !project.is_empty())
        .map(parse_owner_repo)
        .transpose()
}

fn parse_issue_target(target: &str) -> Result<(String, i64)> {
    if let Ok(parsed) = parse_issue_ref(target) {
        return Ok(parsed);
    }

    let trimmed = target.trim().trim_end_matches('/');
    let marker = "github.com/";
    let Some(idx) = trimmed.find(marker) else {
        return Err(anyhow!("expected owner/repo#number or a GitHub issue URL"));
    };
    let path = &trimmed[idx + marker.len()..];
    let parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 4 || parts[2] != "issues" {
        return Err(anyhow!("expected a GitHub issue URL"));
    }

    let repo = parse_owner_repo(&format!("{}/{}", parts[0], parts[1]))?;
    let number_text = parts[3]
        .split(['?', '#'])
        .next()
        .filter(|number| !number.is_empty())
        .ok_or_else(|| anyhow!("issue URL is missing an issue number"))?;
    let number: i64 = number_text
        .parse()
        .map_err(|_| anyhow!("issue number must be a positive integer, got {number_text:?}"))?;
    if number <= 0 {
        return Err(anyhow!(
            "issue number must be a positive integer, got {number}"
        ));
    }
    Ok((repo, number))
}

fn find_task_summary(runtime: &Runtime, task_id: &str) -> Result<TaskSummaryRow> {
    monica_core::list_task_summaries(&runtime.repositories, None, None)?
        .into_iter()
        .find(|row| row.id == task_id)
        .ok_or_else(|| anyhow!("tracked task not found: {task_id}"))
}

fn describe_setup(outcome: &monica_core::SetupOutcome) -> String {
    match outcome {
        monica_core::SetupOutcome::Skipped => "skipped".to_string(),
        monica_core::SetupOutcome::ReusedWorktree => "reused_worktree".to_string(),
        monica_core::SetupOutcome::Succeeded => "succeeded".to_string(),
        monica_core::SetupOutcome::Failed { .. } => "failed".to_string(),
    }
}

fn agent_launch_to_pty(launch: AgentLaunch) -> PtySpawnCommand {
    PtySpawnCommand {
        program: launch.program,
        args: launch.args,
        cwd: launch.cwd,
        env: launch
            .env
            .into_iter()
            .map(|(key, value)| PtySpawnEnv { key, value })
            .collect(),
    }
}
