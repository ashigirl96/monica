/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalSession } from "@/commands/bindings";
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
const {
  adoptClaudeSessionAtom,
  cycleRunspaceAtom,
  detachedSessionsAtom,
  jumpHintsActiveAtom,
  jumpHintTargetsAtom,
  loadTerminalStateAtom,
  reattachSessionAtom,
  terminalStateAtom,
} = await import("./store");

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
  const { saveTerminalStateAtom: saveAtom, terminalStateAtom: stateAtom } = await import("./store");

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

describe("adoptClaudeSessionAtom", () => {
  test("loads the saved snapshot before adopting", async () => {
    loadStateResult = {
      runspaces: [
        {
          id: "rs-saved",
          sort_order: 0,
          tabs: [
            {
              id: "tab-saved",
              cwd: "/home",
              title: "zsh",
              sort_order: 0,
              terminal_session_id: null,
            },
          ],
        },
      ],
    };

    const store = createStore();
    store.set(windowLabelAtom, "main");
    await store.set(adoptClaudeSessionAtom, {
      runspaceId: "agent-runtime",
      tabId: "tab-agent-runtime-1",
      sessionId: "ts-1",
      cwd: "/proj",
    });

    const state = store.get(terminalStateAtom)!;
    // The saved layout survives; the agent runtime runspace is appended, not substituted, and the
    // externally-triggered adopt does not steal the user's focus.
    expect(state.runspaces.map((r) => r.id)).toEqual(["rs-saved", "agent-runtime"]);
    expect(state.activeRunspaceId).toBe("rs-saved");
    const agentRuntime = state.runspaces.find((r) => r.id === "agent-runtime")!;
    expect(agentRuntime.kind).toBe("agent_runtime");
    expect(agentRuntime.tabs).toHaveLength(1);
    expect(agentRuntime.tabs[0].id).toBe("tab-agent-runtime-1");
    expect(agentRuntime.tabs[0].sessionId).toBe("ts-1");
    expect(agentRuntime.tabs[0].cwd).toBe("/proj");
    expect(agentRuntime.activeTabId).toBe("tab-agent-runtime-1");
  });

  test("reuses the existing agent runtime runspace for later sessions", async () => {
    const store = createStore();
    store.set(windowLabelAtom, "main");
    await store.set(adoptClaudeSessionAtom, {
      runspaceId: "agent-runtime",
      tabId: "t1",
      sessionId: "ts-1",
      cwd: "/a",
    });
    await store.set(adoptClaudeSessionAtom, {
      runspaceId: "agent-runtime",
      tabId: "t2",
      sessionId: "ts-2",
      cwd: "/b",
    });

    const state = store.get(terminalStateAtom)!;
    const agentRuntimeRunspaces = state.runspaces.filter((r) => r.id === "agent-runtime");
    expect(agentRuntimeRunspaces).toHaveLength(1);
    expect(agentRuntimeRunspaces[0].tabs.map((t) => t.sessionId)).toEqual(["ts-1", "ts-2"]);
    // Adding a session leaves whatever tab the user last looked at active.
    expect(agentRuntimeRunspaces[0].activeTabId).toBe("t1");
  });

  test("a session already bound to a tab is not adopted twice", async () => {
    const store = createStore();
    store.set(windowLabelAtom, "main");
    const payload = { runspaceId: "agent-runtime", tabId: "t1", sessionId: "ts-1", cwd: "/a" };
    await store.set(adoptClaudeSessionAtom, payload);
    await store.set(adoptClaudeSessionAtom, { ...payload, tabId: "t-other" });

    const agentRuntime = store
      .get(terminalStateAtom)!
      .runspaces.find((r) => r.id === "agent-runtime")!;
    expect(agentRuntime.tabs).toHaveLength(1);
  });

  test("clears the adopted session from the detached list", async () => {
    const store = createStore();
    store.set(windowLabelAtom, "main");
    // Load first: adoption's own load path recomputes the detached list from the (empty)
    // mocked session list and would wipe the seed below.
    await store.set(loadTerminalStateAtom);
    // A reconcile that ran before adoption classified the unbound session as detached.
    store.set(detachedSessionsAtom, [
      { id: "ts-1" },
      { id: "ts-other" },
    ] as unknown as TerminalSession[]);

    await store.set(adoptClaudeSessionAtom, {
      runspaceId: "agent-runtime",
      tabId: "t1",
      sessionId: "ts-1",
      cwd: "/a",
    });

    expect(store.get(detachedSessionsAtom).map((s) => s.id)).toEqual(["ts-other"]);
  });

  test("falls back to a fresh tab id on collision and applies the title", async () => {
    const store = createStore();
    store.set(windowLabelAtom, "main");
    await store.set(adoptClaudeSessionAtom, {
      runspaceId: "agent-runtime",
      tabId: "t1",
      sessionId: "ts-1",
      cwd: "/a",
    });
    await store.set(adoptClaudeSessionAtom, {
      runspaceId: "agent-runtime",
      tabId: "t1",
      sessionId: "ts-2",
      cwd: "/b",
      title: "translator",
    });

    const agentRuntime = store
      .get(terminalStateAtom)!
      .runspaces.find((r) => r.id === "agent-runtime")!;
    expect(agentRuntime.tabs).toHaveLength(2);
    expect(agentRuntime.tabs[1].id).not.toBe("t1");
    expect(agentRuntime.tabs[1].sessionId).toBe("ts-2");
    expect(agentRuntime.tabs[1].title).toBe("translator");
  });
});

describe("reattachSessionAtom", () => {
  function makeSession(overrides: Partial<TerminalSession>): TerminalSession {
    return {
      id: "ts-1",
      runspace_id: null,
      tab_id: null,
      kind: "shell",
      cwd: "/a",
      ...overrides,
    } as TerminalSession;
  }

  test("rebuilds the agent runtime runspace instead of merging into a standard one", () => {
    const store = createStore();
    store.set(terminalStateAtom, makeState([makeRunspace("rs-1", { order: 0 })]));

    store.set(
      reattachSessionAtom,
      makeSession({ runspace_id: "agent-runtime", tab_id: "t1", kind: "agent" }),
    );

    const state = store.get(terminalStateAtom)!;
    const rebuilt = state.runspaces.find((r) => r.id === "agent-runtime")!;
    expect(rebuilt.kind).toBe("agent_runtime");
    expect(rebuilt.tabs.map((t) => t.sessionId)).toEqual(["ts-1"]);
    expect(state.runspaces.find((r) => r.id === "rs-1")!.tabs).toHaveLength(1);
    expect(state.activeRunspaceId).toBe("agent-runtime");
  });

  test("still merges a standard session into the active runspace when its runspace is gone", () => {
    const store = createStore();
    store.set(terminalStateAtom, makeState([makeRunspace("rs-1", { order: 0 })]));

    store.set(reattachSessionAtom, makeSession({ runspace_id: "rs-gone", tab_id: "t1" }));

    const state = store.get(terminalStateAtom)!;
    expect(state.runspaces.map((r) => r.id)).toEqual(["rs-1"]);
    expect(state.runspaces[0].tabs.map((t) => t.sessionId)).toEqual([undefined, "ts-1"]);
  });

  test("prefers the surviving agent runtime runspace over rebuilding", () => {
    const store = createStore();
    store.set(
      terminalStateAtom,
      makeState(
        [
          makeRunspace("rs-1", { order: 0 }),
          makeRunspace("agent-runtime", { order: 1, kind: "agent_runtime" }),
        ],
        "rs-1",
      ),
    );

    store.set(
      reattachSessionAtom,
      makeSession({ runspace_id: "agent-runtime", tab_id: "t9", kind: "agent" }),
    );

    const state = store.get(terminalStateAtom)!;
    const agentRuntime = state.runspaces.find((r) => r.id === "agent-runtime")!;
    expect(agentRuntime.tabs.map((t) => t.sessionId)).toEqual([undefined, "ts-1"]);
    expect(state.runspaces.filter((r) => r.id === "agent-runtime")).toHaveLength(1);
  });
});

describe("cycleRunspaceAtom", () => {
  function seedState(store: ReturnType<typeof createStore>, activeId: string) {
    store.set(terminalStateAtom, {
      runspaces: [
        makeRunspace("rs-1", { order: 0 }),
        makeRunspace("agent-runtime", { order: 1, kind: "agent_runtime" }),
        makeRunspace("rs-2", { order: 2 }),
      ],
      activeRunspaceId: activeId,
    });
  }

  test("skips agent runtime runspaces cycling down", () => {
    const store = createStore();
    seedState(store, "rs-1");
    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-2");
  });

  test("skips agent runtime runspaces cycling up", () => {
    const store = createStore();
    seedState(store, "rs-2");
    store.set(cycleRunspaceAtom, "up");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-1");
  });

  test("escapes an active agent runtime runspace into the normal set", () => {
    const store = createStore();
    seedState(store, "agent-runtime");
    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-1");

    seedState(store, "agent-runtime");
    store.set(cycleRunspaceAtom, "up");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-2");
  });

  test("escapes even when a single normal runspace remains", () => {
    const store = createStore();
    store.set(terminalStateAtom, {
      runspaces: [
        makeRunspace("rs-1", { order: 0 }),
        makeRunspace("agent-runtime", { order: 1, kind: "agent_runtime" }),
      ],
      activeRunspaceId: "agent-runtime",
    });
    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("rs-1");
  });

  test("does nothing when only agent runtime runspaces exist", () => {
    const store = createStore();
    store.set(terminalStateAtom, {
      runspaces: [makeRunspace("agent-runtime", { order: 0, kind: "agent_runtime" })],
      activeRunspaceId: "agent-runtime",
    });
    store.set(cycleRunspaceAtom, "down");
    expect(store.get(terminalStateAtom)!.activeRunspaceId).toBe("agent-runtime");
  });
});

describe("jumpHintTargetsAtom", () => {
  test("assigns the reserved 0 key to agent runtime runspaces", () => {
    const store = createStore();
    store.set(terminalStateAtom, {
      runspaces: [
        makeRunspace("rs-task", { order: 0, taskId: "task-a" }),
        makeRunspace("agent-runtime", { order: 1, kind: "agent_runtime" }),
        makeRunspace("rs-shell", { order: 2 }),
      ],
      activeRunspaceId: "rs-task",
    });
    store.set(jumpHintsActiveAtom, true);

    const targets = store.get(jumpHintTargetsAtom);
    expect(targets.byRunspaceId["rs-task"]).toBe("1");
    expect(targets.byRunspaceId["rs-shell"]).toBe("2");
    expect(targets.byRunspaceId["agent-runtime"]).toBe("0");
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
    const { refreshSessionsAtom: rAtom } = await import("./store");
    const store = cs();
    store.set(wlAtom, "monica-window-1");
    await store.set(rAtom);

    expect(listCalls).toBe(0);
  });
});
