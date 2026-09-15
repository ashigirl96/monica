/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import { createStore, getDefaultStore } from "jotai";

type RunCall = { taskId: string; agent: string | null; mode: string };

const BLOCKED_TASK_ID = "blocked";
const BLOCKED_MESSAGE = "task MON-9 is blocked by owner/repo#7; land them first or force the run";

// Mocks the leaf that reaches Tauri, not work-board/store itself: replacing that module would
// hand every other test file a stubbed closeTaskAtom for the rest of the process. The stub set
// mirrors work-bench/store.test.ts's, since mock.module is process-global and the two files
// replace the same module.
async function loadNavWithRecordedRuns() {
  const calls: RunCall[] = [];
  mock.module("@/commands/task", () => ({
    launchTask: (taskId: string, agent: string | null, mode: string) => {
      calls.push({ taskId, agent, mode });
      // The backend refuses a task whose upstream issues are unfinished; this id stands in for one.
      if (taskId === BLOCKED_TASK_ID) {
        return Promise.reject(new Error(BLOCKED_MESSAGE));
      }
      return Promise.resolve({
        task_id: taskId,
        task_run_id: "run-1",
        runspace_id: `bench-${taskId}`,
        cwd: "/wt",
        env: [],
        initial_command: "claude",
      });
    },
    takePendingLaunches: () => Promise.resolve([]),
    listBenchRunspaceMap: () => Promise.resolve([]),
    taskShellEnv: () => Promise.resolve([]),
    makeMainTaskRun: () => Promise.resolve(false),
    primaryTabId: () => Promise.resolve(null),
    attachTerminalTab: () => Promise.reject(new Error("not mocked")),
    listTabTaskBindings: () => Promise.resolve([]),
  }));
  const nav = await import("@/features/work-board/nav");
  return { calls, nav };
}

function runMenu(index: number, taskId = "t1") {
  return {
    taskId,
    anchor: { top: 0, left: 0, bottom: 0 },
    itemIndex: 0,
    confirmingClose: false,
    submenu: { kind: "run", index },
  } as const;
}

describe("executeRunAtom", () => {
  test("passes the selected target's agent and mode", async () => {
    const { calls, nav } = await loadNavWithRecordedRuns();
    const store = createStore();

    for (const [index, mode] of [
      [0, "worktree"],
      [1, "in_place"],
    ] as const) {
      store.set(nav.menuAtom, runMenu(index));
      store.set(nav.executeRunAtom);
      await Promise.resolve();

      expect(calls.at(-1)).toEqual({ taskId: "t1", agent: "claude", mode });
      expect(store.get(nav.menuAtom)).toBeNull();
    }
  });

  test("does nothing when the submenu index has no target", async () => {
    const { calls, nav } = await loadNavWithRecordedRuns();
    const store = createStore();
    const before = calls.length;

    store.set(nav.menuAtom, runMenu(nav.AGENT_TARGETS.length));
    store.set(nav.executeRunAtom);
    await Promise.resolve();

    expect(calls.length).toBe(before);
  });

  test("surfaces a refused run instead of failing silently", async () => {
    // The menu fires the run and walks away, so without a handler the backend's refusal — an
    // upstream issue still open, a failed setup — would leave the Run key looking broken.
    const { nav } = await loadNavWithRecordedRuns();
    const { toastsAtom } = await import("@/stores/toast");
    const store = createStore();

    store.set(nav.menuAtom, runMenu(0, BLOCKED_TASK_ID));
    store.set(nav.executeRunAtom);
    await Promise.resolve();
    await Promise.resolve();

    const toasts = getDefaultStore().get(toastsAtom);
    expect(toasts.map((t) => t.message)).toContain(BLOCKED_MESSAGE);
    expect(toasts.at(-1)?.type).toBe("error");
  });
});
