import { invoke } from "@tauri-apps/api/core";
import type { Event, GithubAuthStatus, PullRequestSyncResult, TaskSummaryRow, Task } from "./types";

export function listTasks(): Promise<Task[]> {
  return invoke<Task[]>("list_tasks");
}

export function listTaskSummaries(): Promise<TaskSummaryRow[]> {
  return invoke<TaskSummaryRow[]>("list_task_summaries");
}

export function listEvents(taskId: string): Promise<Event[]> {
  return invoke<Event[]>("list_events", { taskId });
}

export function deleteTask(id: string): Promise<void> {
  return invoke<void>("delete_task", { id });
}

export function syncNextLinkedPullRequest(): Promise<PullRequestSyncResult> {
  return invoke<PullRequestSyncResult>("sync_next_linked_pull_request");
}

export function saveGithubToken(token: string): Promise<GithubAuthStatus> {
  return invoke<GithubAuthStatus>("save_github_token", { token });
}

export function githubAuthStatus(): Promise<GithubAuthStatus> {
  return invoke<GithubAuthStatus>("github_auth_status");
}

export function githubSignOut(): Promise<void> {
  return invoke<void>("github_sign_out");
}

export function openExternal(url: string): Promise<void> {
  return invoke<void>("open_external", { url });
}
