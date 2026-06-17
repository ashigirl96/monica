export const queryKeys = {
  projects: { list: () => ["projects", "list"] as const },
  tasks: {
    summary: (project: string | null) => ["tasks", "summary", project] as const,
    summaryFamily: () => ["tasks", "summary"] as const,
  },
  board: { columns: () => ["board", "columns"] as const },
  taskRuns: { primaryTab: (taskId: string) => ["taskRuns", "primaryTab", taskId] as const },
};

// `tasks.summary` family（filtered/unfiltered 両方）に属する query key かを判定する。
export function isTaskSummaryKey(key: readonly unknown[]): boolean {
  const family = queryKeys.tasks.summaryFamily();
  return key[0] === family[0] && key[1] === family[1];
}
