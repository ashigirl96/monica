import { commands } from "./bindings";

export type { TaskSummaryRow, WorkboardRunReport } from "./bindings";

async function unwrap<T>(
  result: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export function workboardListTasks(project?: string | null) {
  return unwrap(commands.workboardListTasks(project ?? null));
}

export function workboardTrackIssue(target: string) {
  return unwrap(commands.workboardTrackIssue(target));
}

export function workboardRunTask(taskId: string) {
  return unwrap(commands.workboardRunTask(taskId));
}
