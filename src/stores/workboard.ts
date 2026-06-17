import { atom } from "jotai";
import { atomWithMutation, atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import {
  listTaskSummaries,
  getBoardColumns,
  trackGithubIssue,
  prepareTask,
  type DisplayStatus,
  type TaskSummaryRow,
} from "@/commands/task";
import { invalidateTaskSummaries, queryKeys } from "@/stores/query-keys";
import { pushErrorToast } from "@/stores/toast";

const boardColumnsQueryOptions = {
  queryKey: queryKeys.board.columns(),
  queryFn: () => getBoardColumns(),
} as const;
const boardColumnsQueryAtom = atomWithQuery(() => boardColumnsQueryOptions);
export const boardColumnsAtom = atom((get) => get(boardColumnsQueryAtom).data ?? []);

// The board lists every project's tasks, so the summary query always uses the unfiltered
// (project=null) key. The sidebar's status map shares this same cache entry.
const taskSummariesQueryOptions = {
  queryKey: queryKeys.tasks.summary(null),
  queryFn: () => listTaskSummaries(null),
} as const;
const taskSummariesQueryAtom = atomWithQuery(() => taskSummariesQueryOptions);
export const taskSummariesAtom = atom((get) => get(taskSummariesQueryAtom).data ?? []);

export const loadBoardAtom = atom(null, async (get) => {
  // The query atoms fetch lazily on mount; pre-fetch here so a synchronous read right
  // after this resolves sees the cached data instead of the empty default.
  const client = get(queryClientAtom);
  await Promise.all([
    client.ensureQueryData(boardColumnsQueryOptions),
    client.ensureQueryData(taskSummariesQueryOptions),
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

// Reuses the summary query so it shares the board's cache entry. The projection lives in
// `select` so structural sharing keeps a stable identity when no status changed and the
// sidebar doesn't re-render on every poll.
const taskStatusMapQueryAtom = atomWithQuery(() => ({
  ...taskSummariesQueryOptions,
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
