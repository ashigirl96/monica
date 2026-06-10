import { atom } from "jotai";
import {
  listTaskSummaries,
  getBoardColumns,
  listProjects,
  trackGithubIssue,
  openBench,
  prepareTask,
  runTask,
  onTaskRunStatusChanged,
  type TaskSummaryRow,
  type BoardColumn,
  type ProjectEntry,
  type DisplayStatus,
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

export const PREPARE_ELIGIBLE: Set<DisplayStatus> = new Set([
  "inbox",
  "ready",
  "stopped",
  "failed",
]);

// prepare_task always emits task-run:status-changed from its background thread
// (on both success and failure), so an event listener plus a timeout suffices.
function waitForPreparedOrFailed(taskId: string): { promise: Promise<void>; cancel: () => void } {
  let settled = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let unlistenPromise: Promise<() => void> | undefined;

  const cleanup = () => {
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    unlistenPromise?.then((fn) => fn());
  };

  const promise = new Promise<void>((resolve, reject) => {
    unlistenPromise = onTaskRunStatusChanged((payload) => {
      if (settled || payload.task_id !== taskId) return;
      if (payload.status === "prepared") {
        cleanup();
        resolve();
      } else if (payload.status === "failed") {
        cleanup();
        reject(new Error("prepare failed"));
      }
    });

    timeoutTimer = setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error("prepare timed out"));
      }
    }, 120_000);
  });

  return { promise, cancel: cleanup };
}

const runTaskInFlight = new Set<string>();

export const runTaskAtom = atom(null, async (_get, set, taskId: string) => {
  if (runTaskInFlight.has(taskId)) return;
  runTaskInFlight.add(taskId);
  try {
    // The cached summaries can lag behind hook-driven status changes by a
    // polling interval; decide prepare-vs-run from a fresh read.
    const summaries = await set(refreshTaskSummariesAtom);
    const task = summaries.find((t) => t.id === taskId);

    if (task && PREPARE_ELIGIBLE.has(task.status)) {
      const waiter = waitForPreparedOrFailed(taskId);
      try {
        await prepareTask(taskId);
      } catch (e) {
        waiter.cancel();
        throw e;
      }
      await waiter.promise;
    }

    const launch = await runTask(taskId);

    await set(createTaskRunspaceAtom, {
      runspaceId: launch.runspace_id,
      taskId: launch.task_id,
      cwd: launch.cwd,
      launch: {
        env: launch.env,
        initialCommand: launch.initial_command,
      },
    });
    set(activeSpaceAtom, "work-bench");

    await set(refreshTaskSummariesAtom);
  } finally {
    runTaskInFlight.delete(taskId);
  }
});
