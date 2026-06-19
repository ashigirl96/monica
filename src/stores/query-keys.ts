import type { QueryClient } from "@tanstack/query-core";

export const queryKeys = {
  artifacts: {
    essays: () => ["artifacts", "essays"] as const,
    intents: () => ["artifacts", "intents"] as const,
    drafts: () => ["artifacts", "drafts"] as const,
    detail: (id: string) => ["artifacts", "detail", id] as const,
    family: () => ["artifacts"] as const,
  },
  projects: { list: () => ["projects", "list"] as const },
  tasks: {
    summary: (project: string | null) => ["tasks", "summary", project] as const,
    summaryFamily: () => ["tasks", "summary"] as const,
  },
  board: { columns: () => ["board", "columns"] as const },
  taskRuns: { primaryTab: (taskId: string) => ["taskRuns", "primaryTab", taskId] as const },
};

// Invalidate every tasks.summary query (filtered board + unfiltered sidebar). The single
// source for this operation so mutation onSuccess, the manual refresh atom, and the
// event/poll owner stay in lockstep.
export function invalidateTaskSummaries(client: QueryClient) {
  return client.invalidateQueries({ queryKey: queryKeys.tasks.summaryFamily() });
}

// Force a refetch of the tasks.summary family. A manual sync often finds the DB row already
// current (the PR merged before an earlier refresh landed), so invalidate's "stale-then-refetch
// if changed" can be a no-op that never re-pulls. refetchQueries always re-runs the query so the
// board re-renders from the latest list_task_summaries regardless of whether the value changed.
export function refetchTaskSummaries(client: QueryClient) {
  return client.refetchQueries({ queryKey: queryKeys.tasks.summaryFamily() });
}

// `tasks.summary` family（filtered/unfiltered 両方）に属する query key かを判定する。
export function isTaskSummaryKey(key: readonly unknown[]): boolean {
  const family = queryKeys.tasks.summaryFamily();
  return key[0] === family[0] && key[1] === family[1];
}
