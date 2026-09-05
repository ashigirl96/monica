/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import {
  closeOpenTargetMenuAtom,
  moveOpenTargetAtom,
  openTargetMenuAtom,
  openTargetsAtom,
  setOpenTargetIndexAtom,
} from "@/features/work-bench/open-targets";
import { terminalFocusRequestAtom } from "@/features/work-bench/store";
import { taskSummary as task } from "@/features/work-board/test-fixtures";
import { queryKeys } from "@/stores/query-keys";

const ANCHOR = { top: 0, left: 0, bottom: 0 };

function storeWithLinkedTask() {
  const store = createStore();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  store.set(queryClientAtom, qc);
  qc.setQueryData(queryKeys.tasks.summary(null), [
    task({
      id: "t1",
      github_issue_number: 7,
      github_issue_url: "https://github.com/owner/repo/issues/7",
      github_pull_requests: [
        {
          repo: "owner/repo",
          number: 12,
          url: "https://github.com/owner/repo/pull/12",
          status: "open",
          is_open_or_draft: true,
        },
      ],
    }),
  ]);
  return store;
}

describe("openTargetsAtom", () => {
  test("is empty while the menu is closed and lists the task's links once open", () => {
    const store = storeWithLinkedTask();
    expect(store.get(openTargetsAtom)).toEqual([]);
    store.set(openTargetMenuAtom, { taskId: "t1", anchor: ANCHOR, index: 0 });
    expect(store.get(openTargetsAtom).map((t) => t.id)).toEqual(["issue", "pr:12"]);
  });
});

describe("moveOpenTargetAtom", () => {
  test("stops at both ends", () => {
    const store = storeWithLinkedTask();
    store.set(openTargetMenuAtom, { taskId: "t1", anchor: ANCHOR, index: 0 });

    store.set(moveOpenTargetAtom, "up");
    expect(store.get(openTargetMenuAtom)?.index).toBe(0);
    store.set(moveOpenTargetAtom, "down");
    expect(store.get(openTargetMenuAtom)?.index).toBe(1);
    store.set(moveOpenTargetAtom, "down");
    expect(store.get(openTargetMenuAtom)?.index).toBe(1);
  });

  test("is a no-op when the menu is closed", () => {
    const store = createStore();
    store.set(moveOpenTargetAtom, "down");
    expect(store.get(openTargetMenuAtom)).toBeNull();
  });
});

describe("setOpenTargetIndexAtom", () => {
  test("keeps the same state object when the index is unchanged", () => {
    const store = createStore();
    const menu = { taskId: "t1", anchor: ANCHOR, index: 1 };
    store.set(openTargetMenuAtom, menu);
    store.set(setOpenTargetIndexAtom, 1);
    expect(store.get(openTargetMenuAtom)).toBe(menu);
    store.set(setOpenTargetIndexAtom, 0);
    expect(store.get(openTargetMenuAtom)?.index).toBe(0);
  });
});

describe("closeOpenTargetMenuAtom", () => {
  test("clears the menu and hands focus back to the terminal", () => {
    const store = createStore();
    store.set(openTargetMenuAtom, { taskId: "t1", anchor: ANCHOR, index: 0 });
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
