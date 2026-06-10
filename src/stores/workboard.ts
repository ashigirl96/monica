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
    env: bench.env.length > 0 ? bench.env : undefined,
  });
  set(activeSpaceAtom, "work-bench");
});

export const prepareTaskAtom = atom(null, async (_get, set, taskId: string) => {
  await prepareTask(taskId);
  const summaries = await listTaskSummaries();
  set(taskSummariesAtom, summaries);
});

export const refreshTaskSummariesAtom = atom(null, async (_get, set) => {
  const summaries = await listTaskSummaries();
  set(taskSummariesAtom, summaries);
});

const NEEDS_PREPARE: Set<DisplayStatus> = new Set(["inbox", "ready", "stopped", "failed"]);

function waitForPreparedOrFailed(taskId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      unlistenPromise.then((fn) => fn());
    };

    const unlistenPromise = onTaskRunStatusChanged((payload) => {
      if (settled || payload.task_id !== taskId) return;
      if (payload.status === "prepared") {
        cleanup();
        resolve();
      } else if (payload.status === "failed") {
        cleanup();
        reject(new Error("prepare failed"));
      }
    });

    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const summaries = await listTaskSummaries();
        const task = summaries.find((t) => t.id === taskId);
        if (!task) return;
        if (task.status === "prepared") {
          cleanup();
          resolve();
        } else if (task.status === "failed") {
          cleanup();
          reject(new Error("prepare failed"));
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);

    setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error("prepare timed out"));
      }
    }, 120_000);
  });
}

export const runTaskAtom = atom(null, async (get, set, taskId: string) => {
  const summaries = get(taskSummariesAtom);
  const task = summaries.find((t) => t.id === taskId);

  if (task && NEEDS_PREPARE.has(task.status)) {
    const wait = waitForPreparedOrFailed(taskId);
    await prepareTask(taskId);
    await wait;
  }

  const launch = await runTask(taskId);

  set(createTaskRunspaceAtom, {
    runspaceId: launch.runspace_id,
    taskId: launch.task_id,
    cwd: launch.cwd,
    launch: {
      env: launch.env,
      initialCommand: launch.initial_command,
    },
  });
  set(activeSpaceAtom, "work-bench");

  set(taskSummariesAtom, await listTaskSummaries());
});
