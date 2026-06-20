import { atom } from "jotai";
import { atomWithMutation, atomWithQuery, queryClientAtom } from "jotai-tanstack-query";
import {
  listTaskSummaries,
  getBoardColumns,
  trackGithubIssue,
  createRawTask,
  prepareTask,
  type TaskSummaryRow,
} from "@/commands/task";
import { invalidateTaskSummaries, queryKeys } from "@/stores/query-keys";
import { pushErrorToast } from "@/stores/toast";

export const newTaskOpenAtom = atom(false);
export const projectFilterOpenAtom = atom(false);
export const selectedProjectAtom = atom<string | null>(null);

export type BoardView = "tasks" | "intents";
const BOARD_VIEWS: BoardView[] = ["tasks", "intents"];
export const boardViewAtom = atom<BoardView>("tasks");
export const cycleBoardViewAtom = atom(null, (get, set, direction: "up" | "down") => {
  const current = get(boardViewAtom);
  const idx = BOARD_VIEWS.indexOf(current);
  const newIdx =
    direction === "up"
      ? (idx - 1 + BOARD_VIEWS.length) % BOARD_VIEWS.length
      : (idx + 1) % BOARD_VIEWS.length;
  set(boardViewAtom, BOARD_VIEWS[newIdx]);
});

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
  // Runs on every navigation into the board. fetchQuery honours the (zero) staleTime so each
  // entry re-pulls a fresh snapshot, unlike ensureQueryData which returns the cached snapshot
  // without refetching. The awaited result repopulates the cache so the synchronous getQueryData
  // in applyRestored that follows reads fresh data.
  const client = get(queryClientAtom);
  await Promise.all([
    client.fetchQuery(boardColumnsQueryOptions),
    client.fetchQuery(taskSummariesQueryOptions),
  ]);
});

export const columnTasksAtom = atom((get) => {
  const columns = get(boardColumnsAtom);
  const tasks = get(taskSummariesAtom);
  const projectFilter = get(selectedProjectAtom);
  return columns.map((col) => ({
    ...col,
    tasks: tasks.filter(
      (t) =>
        col.statuses.includes(t.status) && (projectFilter === null || t.project === projectFilter),
    ),
  }));
});

// Reuses the summary query so it shares the board's cache entry. The sidebar only renders
// these few fields, so `select` projects down to them: structural sharing then keeps a stable
// identity unless a displayed field changes, sparing the sidebar a re-render when unrelated
// row fields (side runs, PRs, branch) churn during a poll.
export type RunspaceTaskSummary = Pick<
  TaskSummaryRow,
  "title" | "project" | "github_issue_number" | "status" | "task_run_wait_reason"
>;

const taskSummaryByIdQueryAtom = atomWithQuery(() => ({
  ...taskSummariesQueryOptions,
  select: (rows: TaskSummaryRow[]) =>
    Object.fromEntries(
      rows.map((s) => [
        s.id,
        {
          title: s.title,
          project: s.project,
          github_issue_number: s.github_issue_number,
          status: s.status,
          task_run_wait_reason: s.task_run_wait_reason,
        },
      ]),
    ) as Record<string, RunspaceTaskSummary>,
}));
export const taskSummaryByIdAtom = atom<Record<string, RunspaceTaskSummary>>(
  (get) => get(taskSummaryByIdQueryAtom).data ?? {},
);

export const trackIssueMutationAtom = atomWithMutation((get) => ({
  mutationFn: (input: string) => trackGithubIssue(input),
  onSuccess: () => invalidateTaskSummaries(get(queryClientAtom)),
}));

export const createRawTaskMutationAtom = atomWithMutation((get) => ({
  mutationFn: ({ title, projectId }: { title: string; projectId: string }) =>
    createRawTask(title, projectId),
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
