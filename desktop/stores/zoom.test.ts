/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN, clampUiZoom } from "@/stores/zoom";

describe("clampUiZoom", () => {
  test("passes through an in-range value", () => {
    expect(clampUiZoom(1.2)).toBe(1.2);
  });

  test("clamps above the max", () => {
    expect(clampUiZoom(99)).toBe(UI_ZOOM_MAX);
  });

  test("clamps below the min", () => {
    expect(clampUiZoom(0.1)).toBe(UI_ZOOM_MIN);
  });

  test("defaults non-finite and non-number input", () => {
    expect(clampUiZoom(Number.NaN)).toBe(UI_ZOOM_DEFAULT);
    expect(clampUiZoom(Number.POSITIVE_INFINITY)).toBe(UI_ZOOM_DEFAULT);
    expect(clampUiZoom("1.2")).toBe(UI_ZOOM_DEFAULT);
    expect(clampUiZoom(undefined)).toBe(UI_ZOOM_DEFAULT);
    expect(clampUiZoom(null)).toBe(UI_ZOOM_DEFAULT);
  });
});
