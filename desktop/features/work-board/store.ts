import { atom } from "jotai";
import type { Agent } from "@/commands/bindings";
import { closeTask, openBench } from "@/commands/task";
import { runTaskFlow } from "@/features/work-board/run-flow";
import {
  createTaskRunspaceAtom,
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

export const runTaskAtom = atom(null, async (_get, set, taskId: string, agent?: Agent) => {
  const result = await runTaskFlow(taskId, agent ?? null);
  if (!result) return;
  await set(createTaskRunspaceAtom, result);
  await set(refreshTaskSummariesAtom);
});
