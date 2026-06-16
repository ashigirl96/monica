import { atom } from "jotai";
import { atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
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
  type DisplayStatus,
} from "@/commands/task";
import { queryKeys } from "@/stores/query-keys";
import { runTaskFlow } from "@/features/work-board/run-flow";
import {
  activeTerminalTabAtom,
  createTaskRunspaceAtom,
  refreshPrimaryTabAtom,
  removeRunspaceAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { activeSpaceAtom } from "@/stores/space";

export const boardColumnsAtom = atom<BoardColumn[]>([]);
// Already filtered by the selected project; the backend query owns the filter.
export const taskSummariesAtom = atom<TaskSummaryRow[]>([]);

const projectsQueryOptions = {
  queryKey: queryKeys.projects.list(),
  queryFn: () => listProjects(),
} as const;
const projectsQueryAtom = atomWithQuery(() => projectsQueryOptions);
export const projectsAtom = atom((get) => get(projectsQueryAtom).data ?? []);

const selectedProjectBaseAtom = atom<string | null>(null);
export const selectedProjectAtom = atom(
  (get) => get(selectedProjectBaseAtom),
  (_get, set, project: string | null) => {
    set(selectedProjectBaseAtom, project);
    void set(refreshTaskSummariesAtom);
  },
);

export const loadBoardAtom = atom(null, async (get, set) => {
  // Restore reads the projects snapshot synchronously, so warm its cache before resolving.
  const [columns, summaries] = await Promise.all([
    getBoardColumns(),
    listTaskSummaries(get(selectedProjectAtom)),
    get(queryClientAtom).ensureQueryData(projectsQueryOptions),
  ]);
  set(boardColumnsAtom, columns);
  set(taskSummariesAtom, summaries);
});

export const columnTasksAtom = atom((get) => {
  const columns = get(boardColumnsAtom);
  const tasks = get(taskSummariesAtom);
  return columns.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => col.statuses.includes(t.status)),
  }));
});

// The Work Bench sidebar needs every task's status regardless of the board's
// project filter, so this map refreshes from an unfiltered query.
export const taskStatusMapAtom = atom<Record<string, DisplayStatus>>({});

export const refreshTaskStatusMapAtom = atom(null, async (_get, set) => {
  const summaries = await listTaskSummaries(null);
  set(taskStatusMapAtom, Object.fromEntries(summaries.map((s) => [s.id, s.status])));
});

export const trackIssueAtom = atom(null, async (_get, set, input: string) => {
  await trackGithubIssue(input);
  await set(refreshTaskSummariesAtom);
});

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

export const refreshTaskSummariesAtom = atom(null, async (get, set) => {
  const summaries = await listTaskSummaries(get(selectedProjectAtom));
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

export const deleteTaskAtom = atom(null, async (get, set, taskId: string) => {
  const state = get(terminalStateAtom);
  const runspace = state?.runspaces.find((rs) => rs.taskId === taskId);
  await deleteTask(taskId);
  if (runspace) {
    set(removeRunspaceAtom, runspace.id, "terminate");
  }
  await set(refreshTaskSummariesAtom);
});

export const runTaskAtom = atom(null, async (_get, set, taskId: string) => {
  const result = await runTaskFlow(taskId);
  if (!result) return;
  await set(createTaskRunspaceAtom, result);
  set(activeSpaceAtom, "work-bench");
  await set(refreshTaskSummariesAtom);
});
