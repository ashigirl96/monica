import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "./bindings";

export type {
  TaskSummaryRow,
  DisplayStatus,
  GithubPullRequestRef,
  BoardColumn,
  ProjectEntry,
  TrackIssueResult,
  TaskBench,
  PrepareTaskResult,
  RunTaskResult,
} from "./bindings";

async function unwrap<T>(
  result: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export function listTaskSummaries() {
  return unwrap(commands.listTaskSummaries());
}

export function getBoardColumns() {
  return commands.getBoardColumns();
}

export function listProjects() {
  return unwrap(commands.listProjects());
}

export function trackGithubIssue(repo: string, number: number) {
  return unwrap(commands.trackGithubIssue(repo, number));
}

export function listBenchRunspaceMap() {
  return unwrap(commands.listBenchRunspaceMap());
}

export function taskShellEnv(taskId: string) {
  return unwrap(commands.taskShellEnv(taskId));
}

export function openBench(taskId: string) {
  return unwrap(commands.openBench(taskId));
}

export function prepareTask(taskId: string) {
  return unwrap(commands.prepareTask(taskId));
}

export function runTask(taskId: string) {
  return unwrap(commands.runTask(taskId));
}

export function onTaskRunStatusChanged(
  cb: (payload: { task_id: string; task_run_id: string; status: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ task_id: string; task_run_id: string; status: string }>(
    "task-run:status-changed",
    (event) => cb(event.payload),
  );
}
