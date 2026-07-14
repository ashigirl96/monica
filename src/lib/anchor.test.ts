/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { rectToAnchor } from "@/lib/anchor";

describe("rectToAnchor", () => {
  test("keeps top, bottom, left and drops the rest of the rect", () => {
    const rect = { top: 10, bottom: 30, left: 5, right: 100, width: 95, height: 20 } as DOMRect;
    expect(rectToAnchor(rect)).toEqual({ top: 10, bottom: 30, left: 5 });
  });
});
