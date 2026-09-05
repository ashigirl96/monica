/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalRunspace, TerminalState } from "./store";

// --- Pure function tests (no mocking needed) ---

const { enrichRunspacesWithEnv, applyHint } = await import("./store");

function makeRunspace(id: string, overrides?: Partial<TerminalRunspace>): TerminalRunspace {
  return {
    id,
    tabs: [{ id: `${id}-tab`, title: "", cwd: "~", order: 0 }],
    activeTabId: `${id}-tab`,
    order: 0,
    ...overrides,
  };
}

function makeState(runspaces: TerminalRunspace[], activeRunspaceId?: string): TerminalState {
  return {
    runspaces,
    activeRunspaceId: activeRunspaceId ?? runspaces[0]?.id ?? "",
  };
}

describe("enrichRunspacesWithEnv", () => {
  test("maps taskId and env onto runspaces", () => {
    const runspaces = [makeRunspace("rs-1"), makeRunspace("rs-2")];
    const runspaceToTask = new Map([
      ["rs-1", "task-a"],
      ["rs-2", "task-b"],
    ]);
    const envByTask = new Map<string, [string, string][]>([
      ["task-a", [["KEY", "val"]]],
      ["task-b", [["OTHER", "x"]]],
    ]);

    const result = enrichRunspacesWithEnv(runspaces, runspaceToTask, envByTask);

    expect(result[0].taskId).toBe("task-a");
    expect(result[0].env).toEqual([["KEY", "val"]]);
    expect(result[1].taskId).toBe("task-b");
    expect(result[1].env).toEqual([["OTHER", "x"]]);
  });

  test("leaves taskId/env undefined for unmapped runspaces", () => {
    const runspaces = [makeRunspace("rs-1")];
    const runspaceToTask = new Map<string, string>();
    const envByTask = new Map<string, [string, string][]>();

    const result = enrichRunspacesWithEnv(runspaces, runspaceToTask, envByTask);

    expect(result[0].taskId).toBeUndefined();
    expect(result[0].env).toBeUndefined();
  });

  test("treats empty env array as undefined", () => {
    const runspaces = [makeRunspace("rs-1")];
    const runspaceToTask = new Map([["rs-1", "task-a"]]);
    const envByTask = new Map<string, [string, string][]>([["task-a", []]]);

    const result = enrichRunspacesWithEnv(runspaces, runspaceToTask, envByTask);

    expect(result[0].taskId).toBe("task-a");
    expect(result[0].env).toBeUndefined();
  });
});

describe("applyHint", () => {
  test("resolves activeRunspaceId and activeTabId from hint", () => {
    const rs1 = makeRunspace("rs-1", {
      tabs: [
        { id: "tab-1", title: "", cwd: "~", order: 0 },
        { id: "tab-2", title: "", cwd: "~", order: 1 },
      ],
      activeTabId: "tab-1",
    });
    const rs2 = makeRunspace("rs-2");
    const state = makeState([rs1, rs2], "rs-1");

    const result = applyHint(state, { activeRunspaceId: "rs-2", activeTabId: "rs-2-tab" });

    expect(result.activeRunspaceId).toBe("rs-2");
    const activeRs = result.runspaces.find((r) => r.id === "rs-2");
    expect(activeRs?.activeTabId).toBe("rs-2-tab");
    const inactiveRs = result.runspaces.find((r) => r.id === "rs-1");
    expect(inactiveRs?.activeTabId).toBe("tab-1");
  });

  test("falls back to first runspace when hint references missing runspace", () => {
    const rs1 = makeRunspace("rs-1");
    const state = makeState([rs1], "rs-1");

    const result = applyHint(state, { activeRunspaceId: "missing", activeTabId: null });

    expect(result.activeRunspaceId).toBe("rs-1");
  });

  test("does not mutate the original state", () => {
    const rs1 = makeRunspace("rs-1");
    const state = makeState([rs1], "rs-1");
    const original = JSON.parse(JSON.stringify(state));

    applyHint(state, { activeRunspaceId: "rs-1", activeTabId: "rs-1-tab" });

    expect(state).toEqual(original);
  });
});

// --- Atom integration tests (mock Tauri commands) ---

let loadStateResult: {
  runspaces: {
    id: string;
    sort_order: number;
    pinned_tab_id?: string | null;
    tabs: {
      id: string;
      cwd: string;
      title: string;
      sort_order: number;
      terminal_session_id: string | null;
    }[];
  }[];
};
let benchMapResult: [string, string][];
let sessionsResult:
  | {
      id: string;
      status: string;
      exit_code: number | null;
      cwd: string;
      tab_id: string | null;
      runspace_id: string | null;
    }[]
  | null;
let shellEnvResult: Map<string, [string, string][]>;

mock.module("@/commands/terminal", () => ({
  terminalLoadState: () => Promise.resolve(loadStateResult),
  terminalListSessions: () =>
    sessionsResult !== null ? Promise.resolve(sessionsResult) : Promise.reject(new Error("fail")),
  terminalDetach: () => Promise.resolve(),
  terminalSaveState: () => Promise.resolve(),
  terminalTerminate: () => Promise.resolve(),
}));
mock.module("@/commands/task", () => ({
  listBenchRunspaceMap: () => Promise.resolve(benchMapResult),
  taskShellEnv: (tid: string) => Promise.resolve(shellEnvResult.get(tid) ?? []),
  makeMainTaskRun: () => Promise.resolve(false),
  primaryTabId: () => Promise.resolve(null),
}));
mock.module("@/commands/git", () => ({
  worktreeInfo: () => Promise.resolve(null),
}));
mock.module("@/features/work-bench/terminal-connections", () => ({
  releaseTabConnection: () => null,
}));
mock.module("@/stores/workboard", () => {
  const { atom: a } = require("jotai");
  return { refreshTaskSummariesAtom: a(null, () => {}) };
});

// saveTerminalStateAtom uses window.setTimeout; stub it for bun.
if (typeof globalThis.window === "undefined") {
  (globalThis as Record<string, unknown>).window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
}

const { createStore } = await import("jotai");
const { windowLabelAtom } = await import("@/stores/ui-state");
const {
  terminalStateAtom,
  toggleTabPinAtom,
  cycleRunspaceAtom,
  removeRunspaceAtom,
  tabExitedAtom,
  createTaskRunspaceAtom,
} = await import("./store");
const { loadTerminalStateAtom } = await import("./persistence");

// For tests that install no fresh mocks; setups that call mock.module re-import instead.
function storeWithState(state: TerminalState, windowLabel = "main") {
  const store = createStore();
  store.set(windowLabelAtom, windowLabel);
  store.set(terminalStateAtom, state);
  return store;
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  loadStateResult = { runspaces: [] };
  benchMapResult = [];
  sessionsResult = [];
  shellEnvResult = new Map();
});

describe("loadTerminalStateAtom", () => {
  test("loads enriched state from non-empty snapshot", async () => {
    loadStateResult = {
      runspaces: [
        {
          id: "rs-1",
          sort_order: 0,
          tabs: [
            { id: "tab-1", cwd: "/home", title: "zsh", sort_order: 0, terminal_session_id: null },
          ],
        },
      ],
    };
    benchMapResult = [["rs-1", "task-a"]];
    shellEnvResult = new Map([["task-a", [["MONICA", "1"] as [string, string]]]]);

    const store = createStore();
    store.set(windowLabelAtom, "main");
    await store.set(loadTerminalStateAtom);

    const state = store.get(terminalStateAtom);
    expect(state).not.toBeNull();
    expect(state!.runspaces).toHaveLength(1);
    expect(state!.runspaces[0].taskId).toBe("task-a");
    expect(state!.runspaces[0].env).toEqual([["MONICA", "1"]]);
  });

  test("falls back to initial state on empty snapshot", async () => {
    loadStateResult = { runspaces: [] };

    const store = createStore();
    store.set(windowLabelAtom, "main");
    await store.set(loadTerminalStateAtom);

    const state = store.get(terminalStateAtom);
    expect(state).not.toBeNull();
    expect(state!.runspaces).toHaveLength(1);
    expect(state!.runspaces[0].taskId).toBeUndefined();
  });

  test("shares promise for concurrent loads", async () => {
    loadStateResult = { runspaces: [] };

    const store = createStore();
    store.set(windowLabelAtom, "main");
    const p1 = store.set(loadTerminalStateAtom);
    const p2 = store.set(loadTerminalStateAtom);

    expect(p1).toBe(p2);
    await p1;
  });
});

type SavedSnapshot = { runspaces: { id: string; pinned_tab_id: string | null }[] };

async function setupSaveTest(label: string, state?: TerminalState) {
  let saveCalls = 0;
  let saved: SavedSnapshot | undefined;
  mock.module("@/commands/terminal", () => ({
    terminalLoadState: () => Promise.resolve(loadStateResult),
    terminalListSessions: () => Promise.resolve(sessionsResult ?? []),
    terminalDetach: () => Promise.resolve(),
    terminalSaveState: (_label: string, snapshot: SavedSnapshot) => {
      saveCalls++;
      saved = snapshot;
      return Promise.resolve();
    },
    terminalTerminate: () => Promise.resolve(),
  }));

  const { createStore: cs } = await import("jotai");
  const { windowLabelAtom: wlAtom } = await import("@/stores/ui-state");
  const { terminalStateAtom: stateAtom } = await import("./store");
  const { saveTerminalStateAtom: saveAtom } = await import("./persistence");

  const store = cs();
  store.set(wlAtom, label);
  store.set(
    stateAtom,
    state ?? {
      runspaces: [
        {
          id: "rs",
          tabs: [{ id: "t", title: "", cwd: "~", order: 0 }],
          activeTabId: "t",
          order: 0,
        },
      ],
      activeRunspaceId: "rs",
    },
  );

  return { store, saveAtom, getSaveCalls: () => saveCalls, getSaved: () => saved };
}

describe("saveTerminalStateAtom", () => {
  test("debounces: only the last call's snapshot is saved", async () => {
    const { store, saveAtom, getSaveCalls } = await setupSaveTest("main");

    store.set(saveAtom);
    store.set(saveAtom);
    store.set(saveAtom);

    await waitFor(() => getSaveCalls() > 0);
    expect(getSaveCalls()).toBe(1);
  });
});

async function setupTerminateTest(state: TerminalState) {
  const terminatedIds: string[] = [];
  mock.module("@/commands/terminal", () => ({
    terminalLoadState: () => Promise.resolve(loadStateResult),
    terminalListSessions: () => Promise.resolve(sessionsResult ?? []),
    terminalDetach: () => Promise.resolve(),
    terminalSaveState: () => Promise.resolve(),
    terminalTerminate: (id: string) => {
      terminatedIds.push(id);
      return Promise.resolve();
    },
  }));

  const { createStore: cs } = await import("jotai");
  const { windowLabelAtom: wlAtom } = await import("@/stores/ui-state");
  const { terminalStateAtom: stateAtom, terminateTabSessionAtom: termAtom } =
    await import("./store");

  const store = cs();
  store.set(wlAtom, "main");
  store.set(stateAtom, state);
  return { store, stateAtom, termAtom, terminatedIds };
}

describe("terminateTabSessionAtom", () => {
  test("terminates the tab's session, then closes the tab", async () => {
    const { store, stateAtom, termAtom, terminatedIds } = await setupTerminateTest({
      runspaces: [
        {
          id: "rs",
          tabs: [
            { id: "t1", title: "", cwd: "~", order: 0, sessionId: "sess-1" },
            { id: "t2", title: "", cwd: "~", order: 1 },
          ],
          activeTabId: "t1",
          order: 0,
        },
      ],
      activeRunspaceId: "rs",
    });

    await store.set(termAtom, "t1");

    expect(terminatedIds).toEqual(["sess-1"]);
    const tabs = store.get(stateAtom)!.runspaces[0].tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs.find((t) => t.id === "t1")).toBeUndefined();
  });
});

describe("toggleTabPinAtom", () => {
  test("pins a task runspace in place and moves it to the end of the order", () => {
    const taskRs = makeRunspace("rs-task", { taskId: "task-a", order: 0 });
    const shellRs = makeRunspace("rs-shell", { order: 1 });
    const store = storeWithState(makeState([taskRs, shellRs], "rs-task"));

    store.set(toggleTabPinAtom, "rs-task-tab");

    const rs = store.get(terminalStateAtom)!.runspaces.find((r) => r.id === "rs-task")!;
    expect(rs.pinnedTabId).toBe("rs-task-tab");
    expect(rs.taskId).toBe("task-a");
    expect(rs.tabs).toHaveLength(1);
    expect(rs.order).toBe(2);
  });

  test("unpin clears the flag without touching order or tabs", () => {
    const rs = makeRunspace("rs-1", { pinnedTabId: "rs-1-tab", order: 5 });
    const store = storeWithState(makeState([rs]));

    store.set(toggleTabPinAtom, "rs-1-tab");

    const after = store.get(terminalStateAtom)!.runspaces[0];
    expect(after.pinnedTabId).toBeUndefined();
    expect(after.order).toBe(5);
    expect(after.tabs).toHaveLength(1);
  });

  test("pins a single-tab shell in place without creating a runspace", () => {
    const shell = makeRunspace("rs-shell", { order: 0 });
    const store = storeWithState(makeState([shell]));

    store.set(toggleTabPinAtom, "rs-shell-tab");

    const state = store.get(terminalStateAtom)!;
    expect(state.runspaces).toHaveLength(1);
    expect(state.runspaces[0].id).toBe("rs-shell");
    expect(state.runspaces[0].pinnedTabId).toBe("rs-shell-tab");
  });

  test("extracts a tab from a multi-tab shell into a new pinned runspace", () => {
    const shell = makeRunspace("rs-shell", {
      tabs: [
        { id: "t1", title: "", cwd: "~", order: 0 },
        { id: "t2", title: "", cwd: "/work", order: 1, sessionId: "sess-2" },
        { id: "t3", title: "", cwd: "~", order: 2 },
      ],
      activeTabId: "t2",
      order: 0,
    });
    const store = storeWithState(makeState([shell], "rs-shell"));

    store.set(toggleTabPinAtom, "t2");

    const state = store.get(terminalStateAtom)!;
    expect(state.runspaces).toHaveLength(2);

    const original = state.runspaces.find((r) => r.id === "rs-shell")!;
    expect(original.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(original.pinnedTabId).toBeUndefined();
    expect(original.activeTabId).toBe("t3");

    const pinned = state.runspaces.find((r) => r.id !== "rs-shell")!;
    expect(pinned.pinnedTabId).toBe("t2");
    expect(pinned.tabs).toHaveLength(1);
    expect(pinned.tabs[0].id).toBe("t2");
    expect(pinned.tabs[0].sessionId).toBe("sess-2");
    expect(pinned.tabs[0].cwd).toBe("/work");
    expect(pinned.order).toBe(1);
    expect(state.activeRunspaceId).toBe(pinned.id);
  });

  test("re-points the pin when another tab in a pinned runspace is pinned", () => {
    const pinnedShell = makeRunspace("rs-pinned", {
      tabs: [
        { id: "t1", title: "", cwd: "~", order: 0 },
        { id: "t2", title: "", cwd: "~", order: 1 },
      ],
      activeTabId: "t2",
      order: 3,
      pinnedTabId: "t1",
    });
    const store = storeWithState(makeState([pinnedShell]));

    store.set(toggleTabPinAtom, "t2");

    const state = store.get(terminalStateAtom)!;
    expect(state.runspaces).toHaveLength(1);
    const rs = state.runspaces[0];
    expect(rs.pinnedTabId).toBe("t2");
    expect(rs.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(rs.order).toBe(3);
  });

  test("is a no-op in a secondary window", () => {
    const rs = makeRunspace("rs-1");
    const store = storeWithState(makeState([rs]), "monica-window-1");

    store.set(toggleTabPinAtom, "rs-1-tab");

    expect(store.get(terminalStateAtom)!.runspaces[0].pinnedTabId).toBeUndefined();
  });
});

describe("pin guards", () => {
  test("closeTerminalTabAtom is a no-op for the pinned tab", async () => {
    let detachCalls = 0;
    mock.module("@/commands/terminal", () => ({
      terminalLoadState: () => Promise.resolve(loadStateResult),
      terminalListSessions: () => Promise.resolve(sessionsResult ?? []),
      terminalDetach: () => {
        detachCalls++;
        return Promise.resolve();
      },
      terminalSaveState: () => Promise.resolve(),
      terminalTerminate: () => Promise.resolve(),
    }));

    const { createStore: cs } = await import("jotai");
    const { windowLabelAtom: wlAtom } = await import("@/stores/ui-state");
    const { terminalStateAtom: stateAtom, closeTerminalTabAtom: closeAtom } =
      await import("./store");

    const store = cs();
    store.set(wlAtom, "main");
    store.set(stateAtom, {
      runspaces: [
        {
          id: "rs",
          tabs: [
            { id: "t1", title: "", cwd: "~", order: 0, sessionId: "sess-1" },
            { id: "t2", title: "", cwd: "~", order: 1, sessionId: "sess-2" },
          ],
          activeTabId: "t1",
          order: 0,
          pinnedTabId: "t1",
        },
      ],
      activeRunspaceId: "rs",
    });

    store.set(closeAtom, "t1");
    expect(store.get(stateAtom)!.runspaces[0].tabs).toHaveLength(2);
    expect(detachCalls).toBe(0);

    // Other tabs in the pinned runspace close normally.
    store.set(closeAtom, "t2");
    expect(store.get(stateAtom)!.runspaces[0].tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(detachCalls).toBe(1);
  });

  test("terminateTabSessionAtom is a no-op for the pinned tab", async () => {
    const { store, stateAtom, termAtom, terminatedIds } = await setupTerminateTest({
      runspaces: [
        {
          id: "rs",
          tabs: [{ id: "t1", title: "", cwd: "~", order: 0, sessionId: "sess-1" }],
          activeTabId: "t1",
          order: 0,
          pinnedTabId: "t1",
        },
      ],
      activeRunspaceId: "rs",
    });

    await store.set(termAtom, "t1");

    expect(terminatedIds).toEqual([]);
    expect(store.get(stateAtom)!.runspaces[0].tabs).toHaveLength(1);
  });

  test("removeRunspaceAtom is a no-op for a pinned runspace", () => {
    const pinnedRs = makeRunspace("rs-pinned", { pinnedTabId: "rs-pinned-tab" });
    const store = storeWithState(makeState([pinnedRs, makeRunspace("rs-other", { order: 1 })]));

    store.set(removeRunspaceAtom, "rs-pinned", "terminate");

    expect(store.get(terminalStateAtom)!.runspaces.map((r) => r.id)).toEqual([
      "rs-pinned",
      "rs-other",
    ]);
  });
});

describe("tabExitedAtom", () => {
  test("respawns a shell in place when the exited tab is pinned", () => {
    const store = storeWithState(
      makeState([
        makeRunspace("rs-1", {
          tabs: [{ id: "t1", title: "", cwd: "~", order: 0, sessionId: "sess-1" }],
          activeTabId: "t1",
          pinnedTabId: "t1",
        }),
      ]),
    );

    store.set(tabExitedAtom, "t1");

    const rs = store.get(terminalStateAtom)!.runspaces[0];
    expect(rs.tabs).toHaveLength(1);
    expect(rs.tabs[0].sessionId).toBeUndefined();
  });

  test("closes the tab when it is not pinned", () => {
    const store = storeWithState(
      makeState([
        makeRunspace("rs-1", {
          tabs: [
            { id: "t1", title: "", cwd: "~", order: 0, sessionId: "sess-1" },
            { id: "t2", title: "", cwd: "~", order: 1 },
          ],
          activeTabId: "t1",
        }),
      ]),
    );

    store.set(tabExitedAtom, "t1");

    expect(store.get(terminalStateAtom)!.runspaces[0].tabs.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("closeTaskAtom pin guard", () => {
  async function setupCloseTaskTest(pinnedTabId?: string) {
    const closedIds: string[] = [];
    mock.module("@/commands/task", () => ({
      listBenchRunspaceMap: () => Promise.resolve(benchMapResult),
      taskShellEnv: (tid: string) => Promise.resolve(shellEnvResult.get(tid) ?? []),
      makeMainTaskRun: () => Promise.resolve(false),
      primaryTabId: () => Promise.resolve(null),
      openBench: () => Promise.resolve({ runspace_id: "", task_id: "", cwd: "", env: [] }),
      closeTask: (id: string) => {
        closedIds.push(id);
        return Promise.resolve();
      },
    }));
    mock.module("@/features/work-board/run-flow", () => ({
      runTaskFlow: () => Promise.resolve(null),
    }));

    const { createStore: cs } = await import("jotai");
    const { windowLabelAtom: wlAtom } = await import("@/stores/ui-state");
    const { terminalStateAtom: stateAtom } = await import("./store");
    const { closeTaskAtom } = await import("@/features/work-board/store");

    const store = cs();
    store.set(wlAtom, "main");
    store.set(
      stateAtom,
      makeState([makeRunspace("bench-task-a", { taskId: "task-a", pinnedTabId })]),
    );
    return { store, stateAtom, closeTaskAtom, closedIds };
  }

  test("blocks the backend close while the task's runspace is pinned", async () => {
    const { store, stateAtom, closeTaskAtom, closedIds } =
      await setupCloseTaskTest("bench-task-a-tab");

    await store.set(closeTaskAtom, "task-a");

    expect(closedIds).toEqual([]);
    expect(store.get(stateAtom)!.runspaces).toHaveLength(1);
  });

  test("closes normally when the task's runspace is not pinned", async () => {
    const { store, stateAtom, closeTaskAtom, closedIds } = await setupCloseTaskTest();

    await store.set(closeTaskAtom, "task-a");

    expect(closedIds).toEqual(["task-a"]);
    expect(store.get(stateAtom)!.runspaces.some((r) => r.id === "bench-task-a")).toBe(false);
  });
});

describe("visual order with pins", () => {
  test("cycleRunspaceAtom walks pinned → task runs → shells", () => {
    // By raw order: task (0), shell (1), pinned shell (2). Visually the pin comes first.
    const store = storeWithState(
      makeState(
        [
          makeRunspace("rs-task", { taskId: "task-a", order: 0 }),
          makeRunspace("rs-shell", { order: 1 }),
          makeRunspace("rs-pinned", { order: 2, pinnedTabId: "rs-pinned-tab" }),
        ],
        "rs-pinned",
      ),
    );

    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-task");
    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-shell");
    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-pinned");
  });
});

describe("pin persistence", () => {
  test("saved snapshot carries pinned_tab_id", async () => {
    const { store, saveAtom, getSaved } = await setupSaveTest(
      "main",
      makeState([
        makeRunspace("rs-pinned", { pinnedTabId: "rs-pinned-tab" }),
        makeRunspace("rs-plain", { order: 1 }),
      ]),
    );

    store.set(saveAtom);
    await waitFor(() => getSaved() !== undefined);

    const saved = getSaved()!;
    expect(saved.runspaces.find((r) => r.id === "rs-pinned")!.pinned_tab_id).toBe("rs-pinned-tab");
    expect(saved.runspaces.find((r) => r.id === "rs-plain")!.pinned_tab_id).toBeNull();
  });

  test("load restores pinnedTabId from the snapshot", async () => {
    loadStateResult = {
      runspaces: [
        {
          id: "rs-1",
          sort_order: 0,
          pinned_tab_id: "tab-1",
          tabs: [
            { id: "tab-1", cwd: "/home", title: "zsh", sort_order: 0, terminal_session_id: null },
          ],
        },
      ],
    };

    const store = createStore();
    store.set(windowLabelAtom, "main");
    await store.set(loadTerminalStateAtom);

    expect(store.get(terminalStateAtom)!.runspaces[0].pinnedTabId).toBe("tab-1");
  });
});

describe("window isolation", () => {
  test("secondary window loads state from backend", async () => {
    loadStateResult = {
      runspaces: [
        {
          id: "rs-1",
          sort_order: 0,
          tabs: [
            { id: "tab-1", cwd: "/home", title: "zsh", sort_order: 0, terminal_session_id: null },
          ],
        },
      ],
    };

    const store = createStore();
    store.set(windowLabelAtom, "monica-window-1");
    await store.set(loadTerminalStateAtom);

    const state = store.get(terminalStateAtom);
    expect(state).not.toBeNull();
    expect(state!.runspaces).toHaveLength(1);
    expect(state!.runspaces[0].id).toBe("rs-1");
  });

  test("secondary window saves state", async () => {
    const { store, saveAtom, getSaveCalls } = await setupSaveTest("monica-window-1");

    store.set(saveAtom);

    await waitFor(() => getSaveCalls() > 0);
    expect(getSaveCalls()).toBe(1);
  });

  test("secondary window applies pending workbench hint", async () => {
    loadStateResult = {
      runspaces: [
        {
          id: "rs-1",
          sort_order: 0,
          tabs: [
            { id: "tab-1", cwd: "/home", title: "zsh", sort_order: 0, terminal_session_id: null },
          ],
        },
      ],
    };
    const { pendingWorkbenchHintAtom } = await import("@/stores/ui-state");
    const store = createStore();
    store.set(windowLabelAtom, "monica-window-1");
    store.set(pendingWorkbenchHintAtom, { activeRunspaceId: "rs-1", activeTabId: "tab-1" });
    await store.set(loadTerminalStateAtom);

    expect(store.get(pendingWorkbenchHintAtom)).toBeNull();
  });

  test("secondary window refresh skips backend call", async () => {
    let listCalls = 0;
    mock.module("@/commands/terminal", () => ({
      terminalLoadState: () => Promise.resolve(loadStateResult),
      terminalListSessions: () => {
        listCalls++;
        return Promise.resolve([]);
      },
      terminalDetach: () => Promise.resolve(),
      terminalSaveState: () => Promise.resolve(),
      terminalTerminate: () => Promise.resolve(),
    }));

    const { createStore: cs } = await import("jotai");
    const { windowLabelAtom: wlAtom } = await import("@/stores/ui-state");
    const { refreshSessionsAtom: rAtom } = await import("./session-status");
    const store = cs();
    store.set(wlAtom, "monica-window-1");
    await store.set(rAtom);

    expect(listCalls).toBe(0);
  });
});

describe("createTaskRunspaceAtom activation", () => {
  const initial = () => makeState([makeRunspace("shell")], "shell");
  const params = { runspaceId: "bench-T1", taskId: "T1", cwd: "/repo" };

  test("activates the new runspace by default", async () => {
    const store = storeWithState(initial());
    await store.set(createTaskRunspaceAtom, params);
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("bench-T1");
  });

  test("activate: false adds the runspace but keeps the current one active", async () => {
    const store = storeWithState(initial());
    await store.set(createTaskRunspaceAtom, { ...params, activate: false });
    const state = store.get(terminalStateAtom)!;
    expect(state.runspaces.map((r) => r.id)).toEqual(["shell", "bench-T1"]);
    expect(state.activeRunspaceId).toBe("shell");
  });

  test("activate: false on an existing runspace adds the launch tab without switching", async () => {
    const store = storeWithState(
      makeState([makeRunspace("shell"), makeRunspace("bench-T1")], "shell"),
    );
    await store.set(createTaskRunspaceAtom, {
      ...params,
      launch: { env: [], initialCommand: "claude" },
      activate: false,
    });
    const state = store.get(terminalStateAtom)!;
    const bench = state.runspaces.find((r) => r.id === "bench-T1")!;
    expect(bench.tabs).toHaveLength(2);
    expect(bench.activeTabId).toBe(bench.tabs[1].id);
    expect(state.activeRunspaceId).toBe("shell");
  });
});
