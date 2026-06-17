/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { isTaskSummaryKey, queryKeys } from "@/stores/query-keys";

describe("queryKeys", () => {
  test("projects.list returns a stable tuple", () => {
    expect(queryKeys.projects.list()).toEqual(["projects", "list"]);
  });

  test("board.columns returns a stable tuple", () => {
    expect(queryKeys.board.columns()).toEqual(["board", "columns"]);
  });

  test("taskRuns.primaryTab carries the task id", () => {
    expect(queryKeys.taskRuns.primaryTab("task1")).toEqual(["taskRuns", "primaryTab", "task1"]);
  });

  test("tasks.summary maps the project argument into the key", () => {
    expect(queryKeys.tasks.summary(null)).toEqual(["tasks", "summary", null]);
    expect(queryKeys.tasks.summary("owner/repo")).toEqual(["tasks", "summary", "owner/repo"]);
  });

  test("tasks.summary keys differ between unfiltered and filtered reads", () => {
    expect(queryKeys.tasks.summary(null)).not.toEqual(queryKeys.tasks.summary("owner/repo"));
  });

  test("summaryFamily is the shared prefix of every tasks.summary key", () => {
    const family = queryKeys.tasks.summaryFamily();
    expect([...family]).toEqual(["tasks", "summary"]);
    for (const project of [null, "owner/repo"]) {
      const key = queryKeys.tasks.summary(project);
      expect(key.slice(0, family.length)).toEqual([...family]);
    }
  });

  test("is a pure mapping of arguments (same input, equal output)", () => {
    expect(queryKeys.tasks.summary("owner/repo")).toEqual(queryKeys.tasks.summary("owner/repo"));
    expect(queryKeys.projects.list()).toEqual(queryKeys.projects.list());
  });
});

describe("isTaskSummaryKey", () => {
  test("matches filtered and unfiltered task summary keys", () => {
    expect(isTaskSummaryKey(queryKeys.tasks.summary(null))).toBe(true);
    expect(isTaskSummaryKey(queryKeys.tasks.summary("owner/repo"))).toBe(true);
    expect(isTaskSummaryKey(queryKeys.tasks.summaryFamily())).toBe(true);
  });

  test("rejects other query families", () => {
    expect(isTaskSummaryKey(queryKeys.projects.list())).toBe(false);
    expect(isTaskSummaryKey(queryKeys.board.columns())).toBe(false);
    expect(isTaskSummaryKey(queryKeys.taskRuns.primaryTab("t1"))).toBe(false);
    expect(isTaskSummaryKey([])).toBe(false);
  });
});
