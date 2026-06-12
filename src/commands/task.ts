import type { UnlistenFn } from "@tauri-apps/api/event";
import { commands, events, type TaskRunStatusChanged } from "./bindings";

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

export function listTaskSummaries(project: string | null = null) {
  return unwrap(commands.listTaskSummaries(project));
}

export function getBoardColumns() {
  return commands.getBoardColumns();
}

export function listProjects() {
  return unwrap(commands.listProjects());
}

export function trackGithubIssue(input: string) {
  return unwrap(commands.trackGithubIssue(input));
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

export function deleteTask(taskId: string) {
  return unwrap(commands.deleteTask(taskId));
}

export function makeMainTaskRun(tabId: string) {
  return unwrap(commands.makeMainTaskRun(tabId));
}

export function primaryTabId(taskId: string) {
  return unwrap(commands.primaryTabId(taskId));
}

export function onTaskRunStatusChanged(
  cb: (payload: TaskRunStatusChanged) => void,
): Promise<UnlistenFn> {
  return events.taskRunStatusChanged.listen((event) => cb(event.payload));
}
