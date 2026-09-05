import type { TaskSummaryRow } from "@/commands/bindings";

export function taskSummary(over: Partial<TaskSummaryRow>): TaskSummaryRow {
  return {
    id: "t1",
    title: "task",
    project: "owner/repo",
    github_issue_number: null,
    github_issue_url: null,
    github_issue_state: null,
    github_pull_requests: [],
    task_status: "ready",
    task_run_status: null,
    task_run_wait_reason: null,
    has_plan: false,
    status: "ready",
    prepare_eligible: false,
    run_eligible: false,
    run_needs_prepare: false,
    is_active: false,
    has_open_pull_request: false,
    branch: null,
    side_runs_running: 0,
    side_runs_waiting_for_user: 0,
    side_runs_failed: 0,
    ...over,
  };
}
