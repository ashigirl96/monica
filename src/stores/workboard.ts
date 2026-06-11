import { atom } from "jotai";
import {
  listTaskSummaries,
  getBoardColumns,
  listProjects,
  trackGithubIssue,
  openBench,
  prepareTask,
  deleteTask,
  makeMainTaskRun,
  type TaskSummaryRow,
  type BoardColumn,
  type ProjectEntry,
  type DisplayStatus,
} from "@/commands/task";
import { runTaskFlow } from "@/features/work-board/run-flow";
import {
  activeTerminalTabAtom,
  createTaskRunspaceAtom,
  refreshPrimaryTabAtom,
} from "@/stores/terminal";
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

export const taskStatusMapAtom = atom<Record<string, DisplayStatus>>((get) => {
  const summaries = get(taskSummariesAtom);
  return Object.fromEntries(summaries.map((s) => [s.id, s.status]));
});

export const trackIssueAtom = atom(
  null,
  async (_get, set, input: { repo: string; number: number }) => {
    await trackGithubIssue(input.repo, input.number);
    await set(refreshTaskSummariesAtom);
  },
);

export const openBenchAtom = atom(null, async (_get, set, taskId: string) => {
  const bench = await openBench(taskId);
  await set(createTaskRunspaceAtom, {
    runspaceId: bench.runspace_id,
    taskId: bench.task_id,
    cwd: bench.cwd,
    env: bench.env.length > 0 ? bench.env : undefined,
  });
  set(activeSpaceAtom, "work-bench");
});

export const prepareTaskAtom = atom(null, async (_get, set, taskId: string) => {
  await prepareTask(taskId);
  await set(refreshTaskSummariesAtom);
});

export const refreshTaskSummariesAtom = atom(null, async (_get, set) => {
  const summaries = await listTaskSummaries();
  set(taskSummariesAtom, summaries);
  return summaries;
});

// cmd+g: promote the run living in the focused tab to Main Run. Backend returns
// false for both "no run in this tab" and "already main", keeping this a silent no-op.
export const promoteActiveTabRunAtom = atom(null, async (get, set) => {
  const tab = get(activeTerminalTabAtom);
  if (!tab) return;
  const changed = await makeMainTaskRun(tab.id);
  if (changed) {
    await Promise.all([set(refreshTaskSummariesAtom), set(refreshPrimaryTabAtom)]);
  }
});

export const deleteTaskAtom = atom(null, async (_get, set, taskId: string) => {
  await deleteTask(taskId);
  await set(refreshTaskSummariesAtom);
});

export const runTaskAtom = atom(null, async (_get, set, taskId: string) => {
  const result = await runTaskFlow(taskId);
  if (!result) return;
  await set(createTaskRunspaceAtom, result);
  set(activeSpaceAtom, "work-bench");
  await set(refreshTaskSummariesAtom);
});
