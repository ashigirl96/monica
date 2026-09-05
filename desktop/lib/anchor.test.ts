/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { clipRect, rectToAnchor } from "@/lib/anchor";

describe("rectToAnchor", () => {
  test("keeps top, bottom, left and drops the rest of the rect", () => {
    const rect = { top: 10, bottom: 30, left: 5, right: 100, width: 95, height: 20 } as DOMRect;
    expect(rectToAnchor(rect)).toEqual({ top: 10, bottom: 30, left: 5 });
  });
});

describe("clipRect", () => {
  const viewport = { top: 0, bottom: 800, left: 0, right: 1200 };
  const row = { top: 100, bottom: 124, left: 8, right: 200 };

  test("returns the rect untouched when every clip contains it", () => {
    expect(clipRect(row, [viewport])).toEqual(row);
  });

  test("trims a row that hangs out of its scroll container", () => {
    const scroller = { top: 110, bottom: 700, left: 0, right: 200 };
    expect(clipRect(row, [viewport, scroller])).toEqual({ ...row, top: 110 });
  });

  test("is null for a row scrolled past the top of its container", () => {
    const scroller = { top: 140, bottom: 700, left: 0, right: 200 };
    expect(clipRect(row, [viewport, scroller])).toBeNull();
  });

  test("is null inside a panel collapsed to zero width", () => {
    const collapsed = { top: 0, bottom: 800, left: 0, right: 0 };
    expect(clipRect(row, [viewport, collapsed])).toBeNull();
  });
});
