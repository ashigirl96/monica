/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import type { TaskSummaryRow } from "@/commands/task";
import {
  type MenuAnchor,
  type MenuState,
  findNearestTask,
  focusedTaskIdAtom,
  menuAtom,
  moveMenuItemAtom,
  navigateSubmenuAtom,
  setMenuItemIndexAtom,
} from "@/features/work-board/nav";
import { queryKeys } from "@/stores/query-keys";

const ANCHOR: MenuAnchor = { top: 0, left: 0, bottom: 0 };

function task(over: Partial<TaskSummaryRow>): TaskSummaryRow {
  return {
    id: "t1",
    title: "task",
    project: "owner/repo",
    github_issue_number: null,
    github_pull_requests: [],
    task_status: "ready",
    task_run_status: null,
    task_run_wait_reason: null,
    status: "ready",
    prepare_eligible: false,
    run_eligible: false,
    is_active: false,
    has_open_pull_request: false,
    branch: null,
    side_runs_running: 0,
    side_runs_waiting_for_user: 0,
    side_runs_failed: 0,
    ...over,
  } as TaskSummaryRow;
}

function baseMenu(over?: Partial<MenuState>): MenuState {
  return {
    taskId: "t1",
    anchor: ANCHOR,
    itemIndex: 0,
    confirmingClose: false,
    submenu: null,
    ...over,
  };
}

function storeWithTasks(tasks: TaskSummaryRow[]) {
  const store = createStore();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  store.set(queryClientAtom, qc);
  qc.setQueryData(queryKeys.tasks.summary(null), tasks);
  return store;
}

describe("findNearestTask", () => {
  const cols = [
    { tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    { tasks: [{ id: "d" }] },
    { tasks: [] },
  ];

  test("returns the task at the exact row when it exists", () => {
    expect(findNearestTask(cols, 0, 1)).toBe("b");
  });

  test("clamps to the last row when rowIdx exceeds tasks.length", () => {
    expect(findNearestTask(cols, 1, 5)).toBe("d");
  });

  test("returns null for an empty column", () => {
    expect(findNearestTask(cols, 2, 0)).toBeNull();
  });

  test("returns null for an out-of-bounds column index", () => {
    expect(findNearestTask(cols, 99, 0)).toBeNull();
  });

  test("excludes a task by id", () => {
    expect(findNearestTask(cols, 0, 0, "a")).toBe("b");
  });

  test("returns null when excluding the only task", () => {
    expect(findNearestTask(cols, 1, 0, "d")).toBeNull();
  });
});

describe("moveMenuItemAtom blocks navigation when submenu is active", () => {
  test("blocks when open submenu is active", () => {
    const store = storeWithTasks([task({ id: "t1", prepare_eligible: true, run_eligible: true })]);
    const menu = baseMenu({ itemIndex: 0, submenu: { kind: "open", index: 0 } });
    store.set(menuAtom, menu);

    store.set(moveMenuItemAtom, "down");

    expect(store.get(menuAtom)).toEqual(menu);
  });

  test("blocks when run submenu is active", () => {
    const store = storeWithTasks([task({ id: "t1", prepare_eligible: true, run_eligible: true })]);
    const menu = baseMenu({ itemIndex: 0, submenu: { kind: "run", index: 0 } });
    store.set(menuAtom, menu);

    store.set(moveMenuItemAtom, "down");

    expect(store.get(menuAtom)).toEqual(menu);
  });

  test("allows navigation when submenu is null", () => {
    const store = storeWithTasks([task({ id: "t1", prepare_eligible: true, run_eligible: true })]);
    store.set(menuAtom, baseMenu({ itemIndex: 0, submenu: null }));

    store.set(moveMenuItemAtom, "down");

    const result = store.get(menuAtom);
    expect(result?.itemIndex).not.toBe(0);
  });
});

describe("setMenuItemIndexAtom blocks when submenu is active", () => {
  test("blocks when run submenu is active", () => {
    const store = storeWithTasks([task({ id: "t1", prepare_eligible: true, run_eligible: true })]);
    const menu = baseMenu({ itemIndex: 0, submenu: { kind: "run", index: 0 } });
    store.set(menuAtom, menu);

    store.set(setMenuItemIndexAtom, 1);

    expect(store.get(menuAtom)).toEqual(menu);
  });
});

describe("navigateSubmenuAtom", () => {
  test("enter/open sets submenu to open with index 0", () => {
    const store = storeWithTasks([task({ id: "t1", github_issue_number: 7 })]);
    store.set(menuAtom, baseMenu());

    store.set(navigateSubmenuAtom, { type: "enter", submenu: "open" });

    const menu = store.get(menuAtom);
    expect(menu?.submenu).toEqual({ kind: "open", index: 0 });
  });

  test("enter/open does nothing when task has no open targets", () => {
    const store = storeWithTasks([task({ id: "t1" })]);
    store.set(menuAtom, baseMenu());

    store.set(navigateSubmenuAtom, { type: "enter", submenu: "open" });

    expect(store.get(menuAtom)?.submenu).toBeNull();
  });

  test("enter/run sets submenu to run with index 0", () => {
    const store = storeWithTasks([task({ id: "t1", run_eligible: true })]);
    store.set(menuAtom, baseMenu());

    store.set(navigateSubmenuAtom, { type: "enter", submenu: "run" });

    const menu = store.get(menuAtom);
    expect(menu?.submenu).toEqual({ kind: "run", index: 0 });
  });

  test("enter/run does nothing when not eligible", () => {
    const store = storeWithTasks([task({ id: "t1", run_eligible: false })]);
    store.set(menuAtom, baseMenu());

    store.set(navigateSubmenuAtom, { type: "enter", submenu: "run" });

    expect(store.get(menuAtom)?.submenu).toBeNull();
  });

  test("exit clears submenu", () => {
    const store = createStore();
    store.set(menuAtom, baseMenu({ submenu: { kind: "open", index: 1 } }));

    store.set(navigateSubmenuAtom, { type: "exit" });

    expect(store.get(menuAtom)?.submenu).toBeNull();
  });

  test("exit does nothing when no submenu", () => {
    const store = createStore();
    const menu = baseMenu({ submenu: null });
    store.set(menuAtom, menu);

    store.set(navigateSubmenuAtom, { type: "exit" });

    expect(store.get(menuAtom)).toEqual(menu);
  });

  test("move increments run submenu index", () => {
    const store = createStore();
    store.set(menuAtom, baseMenu({ submenu: { kind: "run", index: 0 } }));

    store.set(navigateSubmenuAtom, { type: "move", direction: "down" });

    expect(store.get(menuAtom)?.submenu).toEqual({ kind: "run", index: 1 });
  });

  test("move does not exceed bounds", () => {
    const store = createStore();
    store.set(menuAtom, baseMenu({ submenu: { kind: "run", index: 1 } }));

    store.set(navigateSubmenuAtom, { type: "move", direction: "down" });

    expect(store.get(menuAtom)?.submenu).toEqual({ kind: "run", index: 1 });
  });

  test("move does not go below 0", () => {
    const store = createStore();
    store.set(menuAtom, baseMenu({ submenu: { kind: "run", index: 0 } }));

    store.set(navigateSubmenuAtom, { type: "move", direction: "up" });

    expect(store.get(menuAtom)?.submenu).toEqual({ kind: "run", index: 0 });
  });

  test("setIndex updates submenu index", () => {
    const store = createStore();
    store.set(menuAtom, baseMenu({ submenu: { kind: "run", index: 0 } }));

    store.set(navigateSubmenuAtom, { type: "setIndex", index: 1 });

    expect(store.get(menuAtom)?.submenu).toEqual({ kind: "run", index: 1 });
  });

  test("setIndex is no-op when index matches current", () => {
    const store = createStore();
    const menu = baseMenu({ submenu: { kind: "run", index: 0 } });
    store.set(menuAtom, menu);

    store.set(navigateSubmenuAtom, { type: "setIndex", index: 0 });

    expect(store.get(menuAtom)).toBe(menu);
  });

  test("move/setIndex do nothing when no submenu", () => {
    const store = createStore();
    const menu = baseMenu({ submenu: null });
    store.set(menuAtom, menu);

    store.set(navigateSubmenuAtom, { type: "move", direction: "down" });
    expect(store.get(menuAtom)).toEqual(menu);

    store.set(navigateSubmenuAtom, { type: "setIndex", index: 1 });
    expect(store.get(menuAtom)).toEqual(menu);
  });

  test("enter/run without menu and without DOM stays null", () => {
    const g = globalThis as Record<string, unknown>;
    const origDoc = g.document;
    const origCSS = g.CSS;
    g.document = { querySelector: () => null };
    g.CSS = { escape: (s: string) => s };
    try {
      const store = storeWithTasks([task({ id: "t1", run_eligible: true })]);
      store.set(focusedTaskIdAtom, "t1");
      store.set(menuAtom, null);

      store.set(navigateSubmenuAtom, { type: "enter", submenu: "run" });

      expect(store.get(menuAtom)).toBeNull();
    } finally {
      if (origDoc === undefined) delete g.document;
      else g.document = origDoc;
      if (origCSS === undefined) delete g.CSS;
      else g.CSS = origCSS;
    }
  });
});
