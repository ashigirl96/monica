import { commands } from "./bindings";

export type {
  TaskSummaryRow,
  DisplayStatus,
  GithubPullRequestRef,
  BoardColumn,
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
