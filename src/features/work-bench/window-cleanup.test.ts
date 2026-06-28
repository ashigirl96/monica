/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";

let detachCalls: string[];

mock.module("@/commands/terminal", () => ({
  terminalDetach: (sessionId: string) => {
    detachCalls.push(sessionId);
    return Promise.resolve();
  },
}));

let releasedTabs: string[];
mock.module("@/features/work-bench/terminal-connections", () => ({
  releaseTabConnection: (tabId: string) => {
    releasedTabs.push(tabId);
    return tabId === "tab-with-conn" ? "conn-session" : undefined;
  },
}));

mock.module("@/stores/workboard", () => {
  const { atom: a } = require("jotai");
  return { refreshTaskSummariesAtom: a(null, () => {}) };
});

const { detachAllSessions } = await import("./window-cleanup");

describe("detachAllSessions", () => {
  test("no-ops on null state", async () => {
    detachCalls = [];
    releasedTabs = [];
    await detachAllSessions(null);
    expect(detachCalls).toHaveLength(0);
  });

  test("detaches all sessions across runspaces", async () => {
    detachCalls = [];
    releasedTabs = [];
    await detachAllSessions({
      runspaces: [
        {
          id: "rs-1",
          tabs: [
            { id: "tab-1", title: "", cwd: "~", order: 0, sessionId: "s-1" },
            { id: "tab-2", title: "", cwd: "~", order: 1 },
          ],
          activeTabId: "tab-1",
          order: 0,
        },
        {
          id: "rs-2",
          tabs: [{ id: "tab-3", title: "", cwd: "~", order: 0, sessionId: "s-3" }],
          activeTabId: "tab-3",
          order: 1,
        },
      ],
      activeRunspaceId: "rs-1",
    });

    expect(releasedTabs).toEqual(["tab-1", "tab-2", "tab-3"]);
    expect(detachCalls).toEqual(["s-1", "s-3"]);
  });

  test("prefers releaseTabConnection sessionId over tab.sessionId", async () => {
    detachCalls = [];
    releasedTabs = [];
    await detachAllSessions({
      runspaces: [
        {
          id: "rs",
          tabs: [{ id: "tab-with-conn", title: "", cwd: "~", order: 0, sessionId: "tab-session" }],
          activeTabId: "tab-with-conn",
          order: 0,
        },
      ],
      activeRunspaceId: "rs",
    });

    expect(detachCalls).toEqual(["conn-session"]);
  });
});
