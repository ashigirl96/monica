import { invoke } from "@tauri-apps/api/core";
import type { Event, IssueStatusRow, WorkItem } from "./types";

export function listWorkItems(): Promise<WorkItem[]> {
  return invoke<WorkItem[]>("list_work_items");
}

export function listIssueStatuses(): Promise<IssueStatusRow[]> {
  return invoke<IssueStatusRow[]>("list_issue_statuses");
}

export function listEvents(workItemId: string): Promise<Event[]> {
  return invoke<Event[]>("list_events", { workItemId });
}
