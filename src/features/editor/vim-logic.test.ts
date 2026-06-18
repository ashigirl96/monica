/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createInitialMinimalVimState, resolveMinimalVimKey } from "@/features/editor/vim-logic";

describe("resolveMinimalVimKey", () => {
  test("escape enters normal mode", () => {
    expect(resolveMinimalVimKey(createInitialMinimalVimState(), "Escape")).toMatchObject({
      handled: true,
      action: "enterNormal",
      state: { mode: "normal", pending: null },
    });
  });

  test("insert mode passes normal text through", () => {
    expect(resolveMinimalVimKey(createInitialMinimalVimState(), "x")).toMatchObject({
      handled: false,
      action: "none",
      state: { mode: "insert", pending: null },
    });
  });

  test("normal mode maps i and a to insert transitions", () => {
    const normal = { mode: "normal" as const, pending: null };
    expect(resolveMinimalVimKey(normal, "i")).toMatchObject({
      handled: true,
      action: "enterInsert",
      state: { mode: "insert" },
    });
    expect(resolveMinimalVimKey(normal, "a")).toMatchObject({
      handled: true,
      action: "moveRightAndInsert",
      state: { mode: "insert" },
    });
  });

  test("normal mode recognizes block movement", () => {
    const normal = { mode: "normal" as const, pending: null };
    expect(resolveMinimalVimKey(normal, "j").action).toBe("moveNextBlock");
    expect(resolveMinimalVimKey(normal, "k").action).toBe("movePreviousBlock");
  });

  test("dd is a two-key delete command", () => {
    const first = resolveMinimalVimKey({ mode: "normal", pending: null }, "d");
    expect(first).toMatchObject({
      handled: true,
      action: "none",
      state: { mode: "normal", pending: "d" },
    });
    expect(resolveMinimalVimKey(first.state, "d")).toMatchObject({
      handled: true,
      action: "deleteBlock",
      state: { mode: "normal", pending: null },
    });
  });

  test("unknown printable input is blocked in normal mode", () => {
    expect(resolveMinimalVimKey({ mode: "normal", pending: "d" }, "x")).toMatchObject({
      handled: true,
      action: "blockInput",
      state: { mode: "normal", pending: null },
    });
  });
});
