import { atom } from "jotai";
import type { Agent, RunMode } from "@/commands/bindings";
import { closeTask, launchTask, openBench, type CloseTaskOutcome } from "@/commands/task";
import {
  createTaskRunspaceAtom,
  materializePendingLaunchesAtom,
  removeRunspaceAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import {
  flushTerminalStateSaveAtom,
  loadTerminalStateAtom,
} from "@/features/work-bench/persistence";
import { activeSpaceAtom } from "@/stores/space";
import { pushErrorToast } from "@/stores/toast";
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

export const closeTaskAtom = atom(
  null,
  async (get, set, taskId: string, force: boolean): Promise<CloseTaskOutcome> => {
    // Loaded first (a no-op once loaded) so the closed task's runspace is found and torn down
    // even when closing straight from the board.
    await set(loadTerminalStateAtom);
    // The backend refuses a pinned bench from the saved layout; a pin toggled moments ago may
    // still be waiting in the debounced save.
    await set(flushTerminalStateSaveAtom);
    const outcome = await closeTask(taskId, force);
    if (outcome.kind === "refused") return outcome;
    const runspace = get(terminalStateAtom)?.runspaces.find((rs) => rs.taskId === taskId);
    if (runspace) {
      set(removeRunspaceAtom, runspace.id, "terminate");
    }
    await set(refreshTaskSummariesAtom);
    return outcome;
  },
);

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
    } catch (error) {
      // The menu fires this and walks away, so a rejection here has nowhere else to surface.
      // A refusal the reader can act on — an upstream issue still open, setup that failed — has
      // to be said out loud rather than leaving the Run key looking broken.
      pushErrorToast(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      runTaskInFlight.delete(taskId);
    }
    await set(materializePendingLaunchesAtom);
    await set(refreshTaskSummariesAtom);
  },
);
