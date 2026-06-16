export const queryKeys = {
  projects: { list: () => ["projects", "list"] as const },
  // tasks.summary(project) は同一 family。Sidebar の unfiltered read は project=null key に寄せる。
  tasks: { summary: (project: string | null) => ["tasks", "summary", project] as const },
  board: { columns: () => ["board", "columns"] as const },
  taskRuns: { primaryTab: (taskId: string) => ["taskRuns", "primaryTab", taskId] as const },
};
