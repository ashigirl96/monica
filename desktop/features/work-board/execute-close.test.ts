/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import { createStore } from "jotai";
import type { CloseTaskOutcome } from "@/commands/task";

type CloseCall = { taskId: string; force: boolean };

const FORCEABLE: CloseTaskOutcome = {
  kind: "refused",
  blockers: [{ message: "worktree /wt (run-1) has uncommitted changes", forceable: true }],
  forceable: true,
};

const PINNED: CloseTaskOutcome = {
  kind: "refused",
  blockers: [{ message: "a tab in this task's bench is pinned", forceable: false }],
  forceable: false,
};

const realTaskCommands = { ...(await import("@/commands/task")) };

// Only closeTask is replaced: mock.module is process-global, so every other export has to stay
// whatever the rest of the suite imports.
async function loadNavWithCloseOutcomes(outcomes: CloseTaskOutcome[]) {
  const calls: CloseCall[] = [];
  mock.module("@/commands/task", () => ({
    ...realTaskCommands,
    closeTask: (taskId: string, force: boolean) => {
      calls.push({ taskId, force });
      return Promise.resolve(outcomes[calls.length - 1] ?? outcomes.at(-1));
    },
  }));
  const nav = await import("@/features/work-board/nav");
  const { terminalStateAtom } = await import("@/features/work-bench/store");
  const store = createStore();
  // An already-loaded empty layout keeps closeTaskAtom from reaching the terminal commands.
  store.set(terminalStateAtom, { runspaces: [], activeRunspaceId: "" });
  const closeIndex = nav.MENU_ITEMS.findIndex((item) => item.id === "close");
  store.set(nav.menuAtom, {
    taskId: "t1",
    anchor: { top: 0, left: 0, bottom: 0 },
    itemIndex: closeIndex,
    confirmingClose: true,
    submenu: null,
  });
  return { calls, nav, store };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("close refusal", () => {
  test("shows the reasons, then Force close retries with force", async () => {
    const { calls, nav, store } = await loadNavWithCloseOutcomes([FORCEABLE, PINNED]);

    store.set(nav.executeMenuItemAtom);
    await settle();

    expect(calls).toEqual([{ taskId: "t1", force: false }]);
    expect(store.get(nav.menuAtom)?.submenu).toEqual({ kind: "close-refused", refusal: FORCEABLE });

    store.set(nav.executeMenuItemAtom);
    await settle();

    expect(calls).toEqual([
      { taskId: "t1", force: false },
      { taskId: "t1", force: true },
    ]);
  });

  test("offers no force past a pinned tab", async () => {
    const { calls, nav, store } = await loadNavWithCloseOutcomes([PINNED]);

    store.set(nav.executeMenuItemAtom);
    await settle();
    store.set(nav.executeMenuItemAtom);
    await settle();

    expect(calls).toEqual([{ taskId: "t1", force: false }]);
    expect(store.get(nav.menuAtom)?.submenu).toEqual({ kind: "close-refused", refusal: PINNED });
  });

  test("Esc steps back to the menu items", async () => {
    const { nav, store } = await loadNavWithCloseOutcomes([FORCEABLE]);

    store.set(nav.executeMenuItemAtom);
    await settle();
    store.set(nav.navigateSubmenuAtom, { type: "exit" });

    expect(store.get(nav.menuAtom)?.submenu).toBeNull();
  });
});
