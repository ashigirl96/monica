/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import { createStore } from "jotai";

type RunCall = { taskId: string; agent: string | null; mode: string };

// Mocks the leaf that reaches Tauri, not work-board/store itself: replacing that module would
// hand every other test file a stubbed closeTaskAtom for the rest of the process.
async function loadNavWithRecordedRuns() {
  const calls: RunCall[] = [];
  mock.module("@/features/work-board/run-flow", () => ({
    runTaskFlow: (taskId: string, agent: string | null, mode: string) => {
      calls.push({ taskId, agent, mode });
      return Promise.resolve(null);
    },
  }));
  const nav = await import("@/features/work-board/nav");
  return { calls, nav };
}

function runMenu(index: number) {
  return {
    taskId: "t1",
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
});
