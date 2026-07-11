/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@/stores/space";
import { UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN } from "@/stores/zoom";
import {
  type WindowUiState,
  parsePersistedUiState,
  resolveWorkbenchActive,
  resolveWorkboardFocus,
  selectWindowUiState,
  serializeUiStatePatch,
} from "@/stores/ui-state";

const DEFAULT_WINDOW: WindowUiState = {
  activeSpace: "work-board",
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  workbench: { activeRunspaceId: null, activeTabId: null },
  workboard: { focusedTaskId: null },
};

describe("parsePersistedUiState", () => {
  test("parses a window-scoped object and validates each window", () => {
    const state = parsePersistedUiState({
      global: { uiZoom: 1.2 },
      windows: {
        main: {
          activeSpace: "work-bench",
          sidebarOpen: false,
          sidebarWidth: 220,
          workbench: { activeRunspaceId: "rs1", activeTabId: "tab1" },
          workboard: { selectedProject: "owner/repo", focusedTaskId: "task1" },
        },
        "monica-window-1": {
          activeSpace: "work-board",
          sidebarOpen: true,
          sidebarWidth: 300,
          workbench: { activeRunspaceId: null, activeTabId: null },
          workboard: { focusedTaskId: null },
        },
      },
    });
    expect(state.global.uiZoom).toBe(1.2);
    expect(state.windows.main).toEqual({
      activeSpace: "work-bench",
      sidebarOpen: false,
      sidebarWidth: 220,
      workbench: { activeRunspaceId: "rs1", activeTabId: "tab1" },
      workboard: { focusedTaskId: "task1" },
    });
    expect(state.windows["monica-window-1"].activeSpace).toBe("work-board");
    expect(state.windows["monica-window-1"].sidebarWidth).toBe(300);
  });

  test("ignores a legacy flat object and resets to defaults", () => {
    const state = parsePersistedUiState({
      activeSpace: "work-bench",
      sidebarOpen: false,
      sidebarWidth: 220,
      uiZoom: 1.4,
      workbench: { activeRunspaceId: "rs1", activeTabId: "tab1" },
      workboard: { focusedTaskId: "task1" },
    });
    expect(state.global.uiZoom).toBe(UI_ZOOM_DEFAULT);
    expect(state.windows).toEqual({});
  });

  test("falls back to defaults for a non-object (e.g. corrupt JSON)", () => {
    const state = parsePersistedUiState("{bad");
    expect(state.global.uiZoom).toBe(UI_ZOOM_DEFAULT);
    expect(state.windows).toEqual({});
  });

  test("rejects an unknown activeSpace per window", () => {
    expect(
      parsePersistedUiState({ windows: { main: { activeSpace: "nope" } } }).windows.main
        .activeSpace,
    ).toBe("work-board");
  });

  test("maps retired space ids to work-board", () => {
    expect(
      parsePersistedUiState({ windows: { main: { activeSpace: "dashboard" } } }).windows.main
        .activeSpace,
    ).toBe("work-board");
    expect(
      parsePersistedUiState({ windows: { main: { activeSpace: "library" } } }).windows.main
        .activeSpace,
    ).toBe("work-board");
  });

  test("clamps sidebarWidth into range per window", () => {
    const widthOf = (v: unknown) =>
      parsePersistedUiState({ windows: { main: { sidebarWidth: v } } }).windows.main.sidebarWidth;
    expect(widthOf(99999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(widthOf(1)).toBe(SIDEBAR_MIN_WIDTH);
    expect(widthOf("wide")).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test("clamps global uiZoom into range and defaults invalid values", () => {
    expect(parsePersistedUiState({ global: { uiZoom: 99 } }).global.uiZoom).toBe(UI_ZOOM_MAX);
    expect(parsePersistedUiState({ global: { uiZoom: 0.1 } }).global.uiZoom).toBe(UI_ZOOM_MIN);
    expect(parsePersistedUiState({ global: { uiZoom: "big" } }).global.uiZoom).toBe(
      UI_ZOOM_DEFAULT,
    );
    expect(parsePersistedUiState({ global: {} }).global.uiZoom).toBe(UI_ZOOM_DEFAULT);
    expect(parsePersistedUiState({}).global.uiZoom).toBe(UI_ZOOM_DEFAULT);
  });

  test("defaults missing nested hints to null", () => {
    const win = parsePersistedUiState({ windows: { main: { activeSpace: "work-board" } } }).windows
      .main;
    expect(win.workbench).toEqual({ activeRunspaceId: null, activeTabId: null });
    expect(win.workboard).toEqual({ focusedTaskId: null });
  });

  test("defaults a malformed window entry", () => {
    expect(parsePersistedUiState({ windows: { main: "garbage" } }).windows.main).toEqual(
      DEFAULT_WINDOW,
    );
  });
});

describe("selectWindowUiState", () => {
  const state = parsePersistedUiState({
    global: { uiZoom: 1 },
    windows: {
      main: { activeSpace: "work-bench", sidebarWidth: 200 },
      "monica-window-1": { activeSpace: "work-board", sidebarWidth: 320 },
    },
  });

  test("returns the window's own state when present", () => {
    const win = selectWindowUiState(state, "monica-window-1");
    expect(win.activeSpace).toBe("work-board");
    expect(win.sidebarWidth).toBe(320);
  });

  test("falls back to main for an unknown window", () => {
    const fallback = selectWindowUiState(state, "monica-window-9");
    expect(fallback.activeSpace).toBe("work-bench");
    expect(fallback.sidebarWidth).toBe(200);
  });

  test("falls back to defaults when neither the window nor main exist", () => {
    const noMain = parsePersistedUiState({
      windows: { "monica-window-1": { activeSpace: "work-board" } },
    });
    expect(selectWindowUiState(noMain, "monica-window-2")).toEqual(DEFAULT_WINDOW);
  });
});

describe("serializeUiStatePatch", () => {
  const current = parsePersistedUiState({
    global: { uiZoom: 1.3 },
    windows: { main: { activeSpace: "work-board", sidebarWidth: 200 } },
  });
  const patch: WindowUiState = {
    activeSpace: "work-bench",
    sidebarOpen: false,
    sidebarWidth: 280,
    workbench: { activeRunspaceId: "rs", activeTabId: "t" },
    workboard: { focusedTaskId: "task" },
  };

  test("adds a new window without touching existing windows or global", () => {
    const next = serializeUiStatePatch(current, "monica-window-1", patch);
    expect(next.windows["monica-window-1"]).toEqual(patch);
    expect(next.windows.main).toEqual(current.windows.main);
    expect(next.global).toEqual(current.global);
  });

  test("overwrites the patched window", () => {
    const next = serializeUiStatePatch(current, "main", patch);
    expect(next.windows.main).toEqual(patch);
  });

  test("preserves global unless an override is given", () => {
    expect(serializeUiStatePatch(current, "main", patch).global).toEqual(current.global);
    expect(serializeUiStatePatch(current, "main", patch, { uiZoom: 1.5 }).global).toEqual({
      uiZoom: 1.5,
    });
  });
});

describe("resolveWorkbenchActive", () => {
  const runspaces = [
    { id: "a", tabs: [{ id: "t1" }, { id: "t2" }] },
    { id: "b", tabs: [{ id: "t3" }] },
  ];

  test("uses a valid hint", () => {
    expect(resolveWorkbenchActive(runspaces, { activeRunspaceId: "b", activeTabId: "t3" })).toEqual(
      {
        activeRunspaceId: "b",
        activeTabId: "t3",
      },
    );
  });

  test("falls back to first runspace + first tab when the hinted runspace is gone", () => {
    expect(resolveWorkbenchActive(runspaces, { activeRunspaceId: "z", activeTabId: "t9" })).toEqual(
      {
        activeRunspaceId: "a",
        activeTabId: "t1",
      },
    );
  });

  test("falls back to the runspace's first tab when the hinted tab is gone", () => {
    expect(resolveWorkbenchActive(runspaces, { activeRunspaceId: "a", activeTabId: "t9" })).toEqual(
      {
        activeRunspaceId: "a",
        activeTabId: "t1",
      },
    );
  });

  test("uses the first runspace when the hint is empty", () => {
    expect(
      resolveWorkbenchActive(runspaces, { activeRunspaceId: null, activeTabId: null }),
    ).toEqual({ activeRunspaceId: "a", activeTabId: "t1" });
  });

  test("returns empty ids when there are no runspaces", () => {
    expect(resolveWorkbenchActive([], { activeRunspaceId: "a", activeTabId: "t1" })).toEqual({
      activeRunspaceId: "",
      activeTabId: "",
    });
  });
});

describe("resolveWorkboardFocus", () => {
  test("keeps a task that still exists", () => {
    expect(resolveWorkboardFocus(["task1"], { focusedTaskId: "task1" })).toEqual({
      focusedTaskId: "task1",
    });
  });

  test("clears focus on a deleted task", () => {
    expect(resolveWorkboardFocus(["task1"], { focusedTaskId: "deleted" }).focusedTaskId).toBeNull();
  });

  test("clears focus when the hint is empty", () => {
    expect(resolveWorkboardFocus(["task1"], { focusedTaskId: null }).focusedTaskId).toBeNull();
  });
});
