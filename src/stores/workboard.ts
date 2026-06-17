import { atom } from "jotai";
import { atomWithMutation, atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import {
  listTaskSummaries,
  getBoardColumns,
  listProjects,
  trackGithubIssue,
  openBench,
  prepareTask,
  closeTask,
  makeMainTaskRun,
  type DisplayStatus,
  type TaskSummaryRow,
} from "@/commands/task";
import { invalidateTaskSummaries, queryKeys } from "@/stores/query-keys";
import { runTaskFlow } from "@/features/work-board/run-flow";
import {
  activeTerminalTabAtom,
  createTaskRunspaceAtom,
  refreshPrimaryTabAtom,
  removeRunspaceAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { activeSpaceAtom } from "@/stores/space";
import { pushErrorToast } from "@/stores/toast";

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
  placeholderData: (previousData: TaskSummaryRow[] | undefined) => previousData,
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

// Unfiltered task statuses (project=null), reusing the summary query family so it shares the
// board's cache entry. The projection lives in `select` so structural sharing keeps a stable
// identity when no status changed and the sidebar doesn't re-render on every poll.
const taskStatusMapQueryAtom = atomWithQuery(() => ({
  ...taskSummariesQueryOptions(null),
  select: (rows: TaskSummaryRow[]) =>
    Object.fromEntries(rows.map((s) => [s.id, s.status])) as Record<string, DisplayStatus>,
}));
export const taskStatusMapAtom = atom<Record<string, DisplayStatus>>(
  (get) => get(taskStatusMapQueryAtom).data ?? {},
);

export const trackIssueMutationAtom = atomWithMutation((get) => ({
  mutationFn: (input: string) => trackGithubIssue(input),
  onSuccess: () => invalidateTaskSummaries(get(queryClientAtom)),
}));

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

export const prepareTaskMutationAtom = atomWithMutation((get) => ({
  mutationFn: (taskId: string) => prepareTask(taskId),
  onSuccess: () => invalidateTaskSummaries(get(queryClientAtom)),
  onError: (error) => pushErrorToast(error instanceof Error ? error.message : String(error)),
}));

// Invalidate every tasks.summary query (filtered board + unfiltered sidebar) and await the
// refetch. This refreshes the QueryClient cache; the derived read atoms only reflect it on the
// next notify tick, so a caller needing a fresh synchronous read right after must hit the cache
// (client.getQueryData) rather than the derived atom.
export const refreshTaskSummariesAtom = atom(null, (get) =>
  invalidateTaskSummaries(get(queryClientAtom)),
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

export const closeTaskAtom = atom(null, async (get, set, taskId: string) => {
  const state = get(terminalStateAtom);
  const runspace = state?.runspaces.find((rs) => rs.taskId === taskId);
  await closeTask(taskId);
  if (runspace) {
    set(removeRunspaceAtom, runspace.id, "terminate");
  }
  await set(refreshTaskSummariesAtom);
});

export const runTaskAtom = atom(null, async (_get, set, taskId: string) => {
  const result = await runTaskFlow(taskId);
  if (!result) return;
  await set(createTaskRunspaceAtom, result);
  await set(refreshTaskSummariesAtom);
});
