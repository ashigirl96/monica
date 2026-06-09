import { atom } from "jotai";
import {
  listTaskSummaries,
  getBoardColumns,
  listProjects,
  trackGithubIssue,
  openBench,
  runTaskAndOpen,
  type TaskSummaryRow,
  type BoardColumn,
  type ProjectEntry,
} from "@/commands/task";
import { createTaskRunspaceAtom } from "@/stores/terminal";
import { activeSpaceAtom } from "@/stores/space";

export const boardColumnsAtom = atom<BoardColumn[]>([]);
export const taskSummariesAtom = atom<TaskSummaryRow[]>([]);
export const projectsAtom = atom<ProjectEntry[]>([]);
export const selectedProjectAtom = atom<string | null>(null);

export const loadBoardAtom = atom(null, async (_get, set) => {
  const [columns, summaries, projects] = await Promise.all([
    getBoardColumns(),
    listTaskSummaries(),
    listProjects(),
  ]);
  set(boardColumnsAtom, columns);
  set(taskSummariesAtom, summaries);
  set(projectsAtom, projects);
});

export const filteredTasksAtom = atom((get) => {
  const tasks = get(taskSummariesAtom);
  const project = get(selectedProjectAtom);
  if (!project) return tasks;
  return tasks.filter((t) => t.project === project);
});

export const columnTasksAtom = atom((get) => {
  const columns = get(boardColumnsAtom);
  const tasks = get(filteredTasksAtom);
  return columns.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => col.statuses.includes(t.status)),
  }));
});

export const trackIssueAtom = atom(
  null,
  async (_get, set, input: { repo: string; number: number }) => {
    await trackGithubIssue(input.repo, input.number);
    const summaries = await listTaskSummaries();
    set(taskSummariesAtom, summaries);
  },
);

export const openBenchAtom = atom(null, async (_get, set, taskId: string) => {
  const bench = await openBench(taskId);
  set(createTaskRunspaceAtom, {
    runspaceId: bench.runspace_id,
    taskId: bench.task_id,
    cwd: bench.cwd,
  });
  set(activeSpaceAtom, "work-bench");
});

export const runTaskAndOpenAtom = atom(null, async (_get, set, taskId: string) => {
  const run = await runTaskAndOpen(taskId);
  set(createTaskRunspaceAtom, {
    runspaceId: run.runspace_id,
    taskId: run.task_id,
    cwd: run.worktree_path,
    taskRunId: run.task_run_id,
    setupLogPath: run.setup_log_path,
    kind: "setup_log",
  });
  set(activeSpaceAtom, "work-bench");
  const summaries = await listTaskSummaries();
  set(taskSummariesAtom, summaries);
});
