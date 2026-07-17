import type { Agent } from "@/commands/bindings";
import {
  listTaskSummaries,
  onTaskRunStatusChanged,
  prepareTask,
  runTask,
  taskShellEnv,
} from "@/commands/task";

export type RunFlowResult = {
  runspaceId: string;
  taskId: string;
  cwd: string;
  env?: [string, string][];
  launch: {
    env: [string, string][];
    initialCommand: string;
  };
};

// prepare_task always emits task-run:status-changed from its background thread
// (on both success and failure), so an event listener plus a timeout suffices.
// Other emitters reuse the same event for the same task (e.g. cmd+g re-emits the
// promoted run's current status), so once the prepared run's id is known the
// listener must match on it, not just the task.
function waitForPreparedOrFailed(taskId: string): {
  promise: Promise<void>;
  cancel: () => void;
  bindRun: (runId: string) => void;
} {
  let settled = false;
  let runId: string | null = null;
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
      if (runId && payload.task_run_id !== runId) return;
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

  return {
    promise,
    cancel: cleanup,
    bindRun: (id) => {
      runId = id;
    },
  };
}

const runTaskInFlight = new Set<string>();

export async function runTaskFlow(
  taskId: string,
  agent: Agent | null = null,
): Promise<RunFlowResult | null> {
  if (runTaskInFlight.has(taskId)) return null;
  runTaskInFlight.add(taskId);
  try {
    // The cached summaries can lag behind hook-driven status changes by a
    // polling interval; decide prepare-vs-run from a fresh read.
    const summaries = await listTaskSummaries();
    const task = summaries.find((t) => t.id === taskId);

    if (task?.prepare_eligible) {
      const waiter = waitForPreparedOrFailed(taskId);
      try {
        const prep = await prepareTask(taskId);
        waiter.bindRun(prep.task_run_id);
      } catch (e) {
        waiter.cancel();
        throw e;
      }
      await waiter.promise;
    }

    const launch = await runTask(taskId, agent);

    // The launch env (with run ids) is consumed by the first tab only; the runspace
    // needs the plain task shell env so later tabs still get the Monica context +
    // claude wrapper and plain `claude` keeps being tracked as a side run.
    const shellEnv = await taskShellEnv(launch.task_id).catch(() => [] as [string, string][]);

    return {
      runspaceId: launch.runspace_id,
      taskId: launch.task_id,
      cwd: launch.cwd,
      env: shellEnv.length > 0 ? shellEnv : undefined,
      launch: {
        env: launch.env,
        initialCommand: launch.initial_command,
      },
    };
  } finally {
    runTaskInFlight.delete(taskId);
  }
}
