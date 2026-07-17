/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import type { TerminalState } from "./store";

let terminateCalls: string[];

mock.module("@/commands/terminal", () => ({
  terminalTerminate: (sessionId: string) => {
    terminateCalls.push(sessionId);
    return Promise.resolve();
  },
}));

let releasedTabs: string[];
mock.module("@/features/work-bench/terminal-connections", () => ({
  releaseTabConnection: (tabId: string) => {
    releasedTabs.push(tabId);
    return undefined;
  },
}));

mock.module("@/stores/workboard", () => {
  const { atom: a } = require("jotai");
  return { refreshTaskSummariesAtom: a(null, () => {}) };
});

const { terminateAllSessions } = await import("./window-cleanup");

const multiRunspaceState: TerminalState = {
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
};

describe("terminateAllSessions", () => {
  test("no-ops on null state", async () => {
    terminateCalls = [];
    releasedTabs = [];
    await terminateAllSessions(null);
    expect(terminateCalls).toHaveLength(0);
  });

  test("terminates all sessions across runspaces", async () => {
    terminateCalls = [];
    releasedTabs = [];
    await terminateAllSessions(multiRunspaceState);

    expect(releasedTabs).toEqual(["tab-1", "tab-2", "tab-3"]);
    expect(terminateCalls).toEqual(["s-1", "s-3"]);
  });
});
