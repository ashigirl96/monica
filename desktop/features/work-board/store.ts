import { atom } from "jotai";
import type { Agent, RunMode } from "@/commands/bindings";
import { closeTask, launchTask, openBench } from "@/commands/task";
import {
  createTaskRunspaceAtom,
  materializePendingLaunchesAtom,
  removeRunspaceAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { loadTerminalStateAtom } from "@/features/work-bench/persistence";
import { activeSpaceAtom } from "@/stores/space";
import { pushInfoToast } from "@/stores/toast";
import { refreshTaskSummariesAtom } from "@/stores/workboard";

// These depend on the work-bench feature because acting on a task drives its terminal
// runspace — a deliberate feature→feature edge that keeps the shared `stores/` read model
// free of feature imports (the dependency that this layer exists to absorb).

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

export const closeTaskAtom = atom(null, async (get, set, taskId: string) => {
  // The pin lives in the terminal state, which may not be loaded yet when closing
  // straight from the board — load it first (a no-op when already loaded) so a
  // persisted pin is not overlooked.
  await set(loadTerminalStateAtom);
  const state = get(terminalStateAtom);
  const runspace = state?.runspaces.find((rs) => rs.taskId === taskId);
  // Backend close_task rips the task's worktrees/branches before the runspace guard
  // below could ever run, so a pinned session blocks the whole close up front.
  if (runspace?.pinnedTabId) {
    pushInfoToast("Task has a pinned session — unpin it before closing");
    return;
  }
  await closeTask(taskId);
  if (runspace) {
    set(removeRunspaceAtom, runspace.id, "terminate");
  }
  await set(refreshTaskSummariesAtom);
});

// A worktree Run blocks in launch_task until setup finishes; a second press meanwhile would only
// surface the backend's "already has an active run" conflict, so it is swallowed here.
const runTaskInFlight = new Set<string>();

// The backend records the launch; materializing right away spares the wait for the bench poll.
export const runTaskAtom = atom(
  null,
  async (_get, set, taskId: string, agent: Agent | null, mode: RunMode) => {
    if (runTaskInFlight.has(taskId)) return;
    runTaskInFlight.add(taskId);
    try {
      await launchTask(taskId, agent, mode);
    } finally {
      runTaskInFlight.delete(taskId);
    }
    await set(materializePendingLaunchesAtom);
    await set(refreshTaskSummariesAtom);
  },
);
