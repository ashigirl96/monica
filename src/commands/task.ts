import type { UnlistenFn } from "@tauri-apps/api/event";
import { commands, events, type TaskRunStatusChanged } from "./bindings";

export type {
  TaskSummaryRow,
  DisplayStatus,
  TaskRunWaitReason,
  GithubPullRequestRef,
  BoardColumn,
  TaskCreated,
  ProjectOption,
  TaskBench,
  PrepareTaskResult,
  RunTaskResult,
} from "./bindings";

import { unwrap } from "./unwrap";

export function listTaskSummaries(project: string | null = null) {
  return unwrap(commands.listTaskSummaries(project));
}

export function getBoardColumns() {
  return commands.getBoardColumns();
}

export function trackGithubIssue(input: string) {
  return unwrap(commands.trackGithubIssue(input));
}

export function listProjects() {
  return unwrap(commands.listProjects());
}

export function createRawTask(title: string, projectId: string) {
  return unwrap(commands.createRawTask(title, projectId));
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

export function closeTask(taskId: string) {
  return unwrap(commands.closeTask(taskId));
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
