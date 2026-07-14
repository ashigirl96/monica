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
const { terminalStateAtom } = await import("./store");
const { loadTerminalStateAtom } = await import("./persistence");

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

async function setupSaveTest(label: string) {
  let saveCalls = 0;
  mock.module("@/commands/terminal", () => ({
    terminalLoadState: () => Promise.resolve(loadStateResult),
    terminalListSessions: () => Promise.resolve(sessionsResult ?? []),
    terminalDetach: () => Promise.resolve(),
    terminalSaveState: () => {
      saveCalls++;
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
  store.set(stateAtom, {
    runspaces: [
      {
        id: "rs",
        tabs: [{ id: "t", title: "", cwd: "~", order: 0 }],
        activeTabId: "t",
        order: 0,
      },
    ],
    activeRunspaceId: "rs",
  });

  return { store, saveAtom, getSaveCalls: () => saveCalls };
}

describe("saveTerminalStateAtom", () => {
  test("debounces: only the last call's snapshot is saved", async () => {
    const { store, saveAtom, getSaveCalls } = await setupSaveTest("main");

    store.set(saveAtom);
    store.set(saveAtom);
    store.set(saveAtom);

    await new Promise((r) => setTimeout(r, 600));
    expect(getSaveCalls()).toBe(1);
  });
});

describe("terminateTabSessionAtom", () => {
  test("terminates the tab's session, then closes the tab", async () => {
    let terminatedId: string | undefined;
    mock.module("@/commands/terminal", () => ({
      terminalLoadState: () => Promise.resolve(loadStateResult),
      terminalListSessions: () => Promise.resolve(sessionsResult ?? []),
      terminalDetach: () => Promise.resolve(),
      terminalSaveState: () => Promise.resolve(),
      terminalTerminate: (id: string) => {
        terminatedId = id;
        return Promise.resolve();
      },
    }));

    const { createStore: cs } = await import("jotai");
    const { windowLabelAtom: wlAtom } = await import("@/stores/ui-state");
    const { terminalStateAtom: stateAtom, terminateTabSessionAtom: termAtom } =
      await import("./store");

    const store = cs();
    store.set(wlAtom, "main");
    store.set(stateAtom, {
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

    expect(terminatedId).toBe("sess-1");
    const tabs = store.get(stateAtom)!.runspaces[0].tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs.find((t) => t.id === "t1")).toBeUndefined();
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

    await new Promise((r) => setTimeout(r, 600));
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
