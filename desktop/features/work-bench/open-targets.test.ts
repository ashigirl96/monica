/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import {
  closeOpenTargetMenuAtom,
  moveOpenTargetAtom,
  openTargetIndexAtom,
  openTargetMenuAtom,
  openTargetMenuStaleAtom,
  openTargetsAtom,
  setOpenTargetIndexAtom,
} from "@/features/work-bench/open-targets";
import { terminalFocusRequestAtom, terminalStateAtom } from "@/features/work-bench/store";
import { taskSummary as task } from "@/features/work-board/test-fixtures";
import { queryKeys } from "@/stores/query-keys";
import { activeSpaceAtom, sidebarOpenAtom } from "@/stores/space";

const ANCHOR = { top: 0, left: 0, bottom: 0 };
const ISSUE_URL = "https://github.com/owner/repo/issues/7";
const PR_URL = "https://github.com/owner/repo/pull/12";

function linkedTask(prs: { number: number; url: string }[]) {
  return task({
    id: "t1",
    github_issue_number: 7,
    github_issue_url: ISSUE_URL,
    github_pull_requests: prs.map((pr) => ({
      repo: "owner/repo",
      number: pr.number,
      url: pr.url,
      status: "open",
      is_open_or_draft: true,
    })),
  });
}

function storeWithLinkedTask() {
  const store = createStore();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  store.set(queryClientAtom, qc);
  qc.setQueryData(queryKeys.tasks.summary(null), [linkedTask([{ number: 12, url: PR_URL }])]);
  store.set(activeSpaceAtom, "work-bench");
  store.set(sidebarOpenAtom, true);
  store.set(terminalStateAtom, {
    runspaces: [
      { id: "rs-1", tabs: [], activeTabId: "", order: 0, taskId: "t1" },
      { id: "rs-2", tabs: [], activeTabId: "", order: 1 },
    ],
    activeRunspaceId: "rs-1",
  });
  return { store, qc };
}

// Subscribing mirrors the mounted menu: without it the derived atom keeps its cached value and
// never sees a later setQueryData.
function openMenu(store: ReturnType<typeof createStore>, selectedUrl = ISSUE_URL) {
  store.set(openTargetMenuAtom, {
    taskId: "t1",
    runspaceId: "rs-1",
    anchor: ANCHOR,
    sidebarOpen: true,
    selectedUrl,
  });
  store.sub(openTargetsAtom, () => {});
}

// atomWithQuery notifies through notifyManager's setTimeout(0), so a refresh lands a tick later.
async function refresh(qc: QueryClient, rows: unknown[]) {
  qc.setQueryData(queryKeys.tasks.summary(null), rows);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openTargetsAtom", () => {
  test("is empty while the menu is closed and lists the task's links once open", () => {
    const { store } = storeWithLinkedTask();
    expect(store.get(openTargetsAtom)).toEqual([]);
    openMenu(store);
    expect(store.get(openTargetsAtom).map((t) => t.id)).toEqual(["issue", "pr:12"]);
  });
});

describe("moveOpenTargetAtom", () => {
  test("stops at both ends", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);

    store.set(moveOpenTargetAtom, "up");
    expect(store.get(openTargetIndexAtom)).toBe(0);
    store.set(moveOpenTargetAtom, "down");
    expect(store.get(openTargetIndexAtom)).toBe(1);
    store.set(moveOpenTargetAtom, "down");
    expect(store.get(openTargetIndexAtom)).toBe(1);
  });

  test("is a no-op when the menu is closed", () => {
    const { store } = storeWithLinkedTask();
    store.set(moveOpenTargetAtom, "down");
    expect(store.get(openTargetMenuAtom)).toBeNull();
  });
});

describe("openTargetIndexAtom", () => {
  test("follows the selected link when a refresh reorders the list", async () => {
    const { store, qc } = storeWithLinkedTask();
    openMenu(store, PR_URL);
    expect(store.get(openTargetIndexAtom)).toBe(1);

    // A newer PR sorts ahead of #12, pushing the selection down a row.
    await refresh(qc, [
      linkedTask([
        { number: 12, url: PR_URL },
        { number: 30, url: "https://github.com/owner/repo/pull/30" },
      ]),
    ]);

    expect(store.get(openTargetsAtom).map((t) => t.id)).toEqual(["issue", "pr:30", "pr:12"]);
    expect(store.get(openTargetIndexAtom)).toBe(2);
  });

  test("falls back to the first row when the selected link disappears", async () => {
    const { store, qc } = storeWithLinkedTask();
    openMenu(store, PR_URL);
    expect(store.get(openTargetIndexAtom)).toBe(1);

    await refresh(qc, [linkedTask([])]);

    expect(store.get(openTargetIndexAtom)).toBe(0);
  });
});

describe("setOpenTargetIndexAtom", () => {
  test("keeps the same state object when the row is already selected", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);
    const menu = store.get(openTargetMenuAtom);

    store.set(setOpenTargetIndexAtom, 0);
    expect(store.get(openTargetMenuAtom)).toBe(menu);
    store.set(setOpenTargetIndexAtom, 1);
    expect(store.get(openTargetIndexAtom)).toBe(1);
  });
});

describe("openTargetMenuStaleAtom", () => {
  test("is false while the menu still describes the active runspace", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);
    expect(store.get(openTargetMenuStaleAtom)).toBe(false);
  });

  test("is false when no menu is open", () => {
    const { store } = storeWithLinkedTask();
    expect(store.get(openTargetMenuStaleAtom)).toBe(false);
  });

  test("goes stale when another space takes over", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);
    store.set(activeSpaceAtom, "work-board");
    expect(store.get(openTargetMenuStaleAtom)).toBe(true);
  });

  test("goes stale when the active runspace changes", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);
    store.set(terminalStateAtom, {
      runspaces: [
        { id: "rs-1", tabs: [], activeTabId: "", order: 0, taskId: "t1" },
        { id: "rs-2", tabs: [], activeTabId: "", order: 1 },
      ],
      activeRunspaceId: "rs-2",
    });
    expect(store.get(openTargetMenuStaleAtom)).toBe(true);
  });

  test("goes stale when ⌘B moves what the anchor pointed at", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);
    store.set(sidebarOpenAtom, false);
    expect(store.get(openTargetMenuStaleAtom)).toBe(true);
  });

  test("goes stale when the task loses every link", async () => {
    const { store, qc } = storeWithLinkedTask();
    openMenu(store);
    expect(store.get(openTargetMenuStaleAtom)).toBe(false);

    await refresh(qc, [task({ id: "t1", github_issue_number: null, github_issue_url: null })]);

    expect(store.get(openTargetMenuStaleAtom)).toBe(true);
  });
});

describe("closeOpenTargetMenuAtom", () => {
  test("clears the menu and hands focus back to the terminal", () => {
    const { store } = storeWithLinkedTask();
    openMenu(store);
    const before = store.get(terminalFocusRequestAtom);

    store.set(closeOpenTargetMenuAtom);

    expect(store.get(openTargetMenuAtom)).toBeNull();
    expect(store.get(terminalFocusRequestAtom)).toBe(before + 1);
  });

  test("does not request focus when nothing was open", () => {
    const store = createStore();
    const before = store.get(terminalFocusRequestAtom);
    store.set(closeOpenTargetMenuAtom);
    expect(store.get(terminalFocusRequestAtom)).toBe(before);
  });
});
