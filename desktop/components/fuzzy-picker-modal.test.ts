/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "@shared/fuzzy-picker/use-fuzzy-picker";

describe("fuzzyMatch", () => {
  test("matches contiguous substrings", () => {
    expect(fuzzyMatch("owner/repo", "repo")).toBe(true);
  });

  test("matches non-contiguous characters in order", () => {
    expect(fuzzyMatch("ashigirl96/monica", "agm")).toBe(true);
  });

  test("does not match out-of-order characters", () => {
    expect(fuzzyMatch("owner/repo", "poo")).toBe(false);
  });

  test("blank query matches everything", () => {
    expect(fuzzyMatch("owner/repo", " ")).toBe(true);
  });
});
