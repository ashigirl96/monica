export type Status =
  | "inbox"
  | "ready"
  | "setting_up"
  | "running"
  | "need_approval"
  | "stopped"
  | "failed"
  | "pr_open"
  | "done"
  | "archived";

export interface WorkItem {
  id: string;
  kind: string;
  status: Status;
  phase: string | null;
  title: string;
  body: string;
  project_id: string | null;
  labels: string[];
  details: unknown;
  source: unknown;
  created_at: string;
  updated_at: string;
}

export interface IssueStatusRow {
  id: string;
  project: string | null;
  github_issue_number: number | null;
  status: Status;
  branch: string | null;
}

export interface Event {
  id: number;
  work_item_id: string | null;
  run_id: string | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

export interface WorkItemView extends WorkItem {
  project: string | null;
  githubIssueNumber: number | null;
  branch: string | null;
}
