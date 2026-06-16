/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { queryKeys } from "@/stores/query-keys";

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

  test("is a pure mapping of arguments (same input, equal output)", () => {
    expect(queryKeys.tasks.summary("owner/repo")).toEqual(queryKeys.tasks.summary("owner/repo"));
    expect(queryKeys.projects.list()).toEqual(queryKeys.projects.list());
  });
});
