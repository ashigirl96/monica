export type DisplayStatus =
  | "inbox"
  | "ready"
  | "in_progress"
  | "setting_up"
  | "running"
  | "waiting_for_user"
  | "stopped"
  | "failed"
  | "done";

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
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSummaryRow {
  id: string;
  project: string | null;
  github_issue_number: number | null;
  task_status: TaskStatus;
  task_run_status: TaskRunStatus | null;
  task_run_wait_reason: TaskRunWaitReason | null;
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
  task_run_wait_reason: TaskRunWaitReason | null;
  project: string | null;
  githubIssueNumber: number | null;
  branch: string | null;
}

export type TaskStatus = "inbox" | "ready" | "in_progress" | "done";

export type TaskRunStatus = "setting_up" | "running" | "waiting_for_user" | "stopped" | "failed";

export type TaskRunWaitReason = "ask_user_question" | "exit_plan_mode";
