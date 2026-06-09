import { commands } from "./bindings";

export type {
  TaskSummaryRow,
  DisplayStatus,
  GithubPullRequestRef,
  BoardColumn,
  ProjectEntry,
  TrackIssueResult,
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
