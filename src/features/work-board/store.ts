import { atom } from "jotai";
import { closeTask, openBench } from "@/commands/task";
import { runTaskFlow } from "@/features/work-board/run-flow";
import {
  createTaskRunspaceAtom,
  removeRunspaceAtom,
  terminalStateAtom,
} from "@/features/work-bench/store";
import { activeSpaceAtom } from "@/stores/space";
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
