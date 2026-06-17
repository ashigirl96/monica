import type { QueryClient } from "@tanstack/query-core";

export const queryKeys = {
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

// `tasks.summary` family（filtered/unfiltered 両方）に属する query key かを判定する。
export function isTaskSummaryKey(key: readonly unknown[]): boolean {
  const family = queryKeys.tasks.summaryFamily();
  return key[0] === family[0] && key[1] === family[1];
}
