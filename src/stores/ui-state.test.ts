/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@/stores/space";
import { parseUiState, resolveWorkbenchActive, resolveWorkboardFocus } from "@/stores/ui-state";

describe("parseUiState", () => {
  test("passes through a valid object", () => {
    const parsed = parseUiState({
      activeSpace: "work-bench",
      sidebarOpen: false,
      sidebarWidth: 220,
      workbench: { activeRunspaceId: "rs1", activeTabId: "tab1" },
      workboard: { selectedProject: "owner/repo", focusedTaskId: "task1" },
    });
    expect(parsed).toEqual({
      activeSpace: "work-bench",
      sidebarOpen: false,
      sidebarWidth: 220,
      workbench: { activeRunspaceId: "rs1", activeTabId: "tab1" },
      workboard: { focusedTaskId: "task1" },
    });
  });

  test("falls back to dashboard defaults for a non-object (e.g. corrupt JSON)", () => {
    const parsed = parseUiState("{bad");
    expect(parsed.activeSpace).toBe("dashboard");
    expect(parsed.sidebarOpen).toBe(true);
    expect(parsed.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parsed.workbench).toEqual({ activeRunspaceId: null, activeTabId: null });
    expect(parsed.workboard).toEqual({ focusedTaskId: null });
  });

  test("rejects an unknown activeSpace", () => {
    expect(parseUiState({ activeSpace: "nope" }).activeSpace).toBe("dashboard");
  });

  test("accepts the editor space", () => {
    expect(parseUiState({ activeSpace: "editor" }).activeSpace).toBe("editor");
  });

  test("clamps sidebarWidth into range", () => {
    expect(parseUiState({ sidebarWidth: 99999 }).sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    expect(parseUiState({ sidebarWidth: 1 }).sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(parseUiState({ sidebarWidth: "wide" }).sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test("defaults missing nested hints to null", () => {
    const parsed = parseUiState({ activeSpace: "work-board" });
    expect(parsed.workbench).toEqual({ activeRunspaceId: null, activeTabId: null });
    expect(parsed.workboard).toEqual({ focusedTaskId: null });
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
