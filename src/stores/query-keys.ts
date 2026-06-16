export const queryKeys = {
  projects: { list: () => ["projects", "list"] as const },
  tasks: {
    summary: (project: string | null) => ["tasks", "summary", project] as const,
    // summary(project) 全体に前方一致する key（一括 invalidate 用）。
    summaryFamily: () => ["tasks", "summary"] as const,
  },
  board: { columns: () => ["board", "columns"] as const },
  taskRuns: { primaryTab: (taskId: string) => ["taskRuns", "primaryTab", taskId] as const },
};
