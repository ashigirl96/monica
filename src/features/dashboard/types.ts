export type DisplayStatus =
  | "inbox"
  | "ready"
  | "active"
  | "setting_up"
  | "running"
  | "need_approval"
  | "stopped"
  | "failed"
  | "pr_open"
  | "done"
  | "archived";

export interface Task {
  id: string;
  kind: string;
  status: TaskStatus;
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

export interface TaskSummaryRow {
  id: string;
  project: string | null;
  github_issue_number: number | null;
  task_status: TaskStatus;
  task_run_status: TaskRunStatus | null;
  status: DisplayStatus;
  branch: string | null;
}

export interface Event {
  id: number;
  task_id: string | null;
  task_run_id: string | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

export interface TaskView extends Omit<Task, "status"> {
  status: DisplayStatus;
  task_status: TaskStatus;
  task_run_status: TaskRunStatus | null;
  project: string | null;
  githubIssueNumber: number | null;
  branch: string | null;
}

export type TaskStatus =
  | "inbox"
  | "ready"
  | "active"
  | "need_approval"
  | "failed"
  | "pr_open"
  | "done"
  | "archived";

export type TaskRunStatus = "setting_up" | "running" | "stopped" | "failed";
