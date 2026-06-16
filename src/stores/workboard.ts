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

// The selected project is local UI state; it only feeds the task-summary query key.
export const selectedProjectAtom = atom<string | null>(null);

const projectsQueryOptions = {
  queryKey: queryKeys.projects.list(),
  queryFn: () => listProjects(),
} as const;
const projectsQueryAtom = atomWithQuery(() => projectsQueryOptions);
export const projectsAtom = atom((get) => get(projectsQueryAtom).data ?? []);

const boardColumnsQueryOptions = {
  queryKey: queryKeys.board.columns(),
  queryFn: () => getBoardColumns(),
} as const;
const boardColumnsQueryAtom = atomWithQuery(() => boardColumnsQueryOptions);
export const boardColumnsAtom = atom((get) => get(boardColumnsQueryAtom).data ?? []);

const taskSummariesQueryOptions = (project: string | null) => ({
  queryKey: queryKeys.tasks.summary(project),
  queryFn: () => listTaskSummaries(project),
});
const taskSummariesQueryAtom = atomWithQuery((get) =>
  taskSummariesQueryOptions(get(selectedProjectAtom)),
);
export const taskSummariesAtom = atom((get) => get(taskSummariesQueryAtom).data ?? []);

export const loadBoardAtom = atom(null, async (get) => {
  // The query atoms fetch lazily on mount; pre-fetch here so a synchronous read right
  // after this resolves sees the cached data instead of the empty default.
  const client = get(queryClientAtom);
  await Promise.all([
    client.ensureQueryData(boardColumnsQueryOptions),
    client.ensureQueryData(taskSummariesQueryOptions(get(selectedProjectAtom))),
    client.ensureQueryData(projectsQueryOptions),
  ]);
});

export const columnTasksAtom = atom((get) => {
  const columns = get(boardColumnsAtom);
  const tasks = get(taskSummariesAtom);
  return columns.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => col.statuses.includes(t.status)),
  }));
});

// Unfiltered task statuses (project=null), independent of the board's project filter.
const taskStatusMapQueryOptions = {
  queryKey: queryKeys.tasks.summary(null),
  queryFn: () => listTaskSummaries(null),
} as const;
const taskStatusMapQueryAtom = atomWithQuery(() => taskStatusMapQueryOptions);
export const taskStatusMapAtom = atom<Record<string, DisplayStatus>>((get) =>
  Object.fromEntries((get(taskStatusMapQueryAtom).data ?? []).map((s) => [s.id, s.status])),
);

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

// Invalidate every tasks.summary query (filtered board + unfiltered sidebar) and await
// the refetch, so callers reading the read model right after see fresh data.
export const refreshTaskSummariesAtom = atom(null, (get) =>
  get(queryClientAtom).invalidateQueries({ queryKey: queryKeys.tasks.summaryFamily() }),
);

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
