/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  type NoteConflict,
  removeConflict,
  shouldAdvanceBase,
  upsertConflict,
  visibleConflicts,
} from "./conflicts";

const V1 = "2026-08-29T10:00:00.000Z";
const V2 = "2026-08-29T10:00:01.000Z";

const A: NoteConflict = { id: "a", label: "Alpha" };
const B: NoteConflict = { id: "b", label: "Beta" };

describe("upsertConflict", () => {
  test("新しい id は末尾に足す", () => {
    expect(upsertConflict([A], B)).toEqual([A, B]);
  });

  test("同じ id は重複させず label だけ更新する", () => {
    expect(upsertConflict([A, B], { id: "a", label: "Alpha 2" })).toEqual([
      { id: "a", label: "Alpha 2" },
      B,
    ]);
  });
});

describe("removeConflict", () => {
  test("該当 id だけ落ちる", () => {
    expect(removeConflict([A, B], "a")).toEqual([B]);
  });

  test("無い id は何も変えない", () => {
    expect(removeConflict([A, B], "zzz")).toEqual([A, B]);
  });
});

describe("visibleConflicts", () => {
  test("開いている note の行は通知に出さない（インラインバナーが担当する）", () => {
    expect(visibleConflicts([A, B], "a")).toEqual([B]);
  });

  test("何も開いていなければ全件出す", () => {
    expect(visibleConflicts([A, B], null)).toEqual([A, B]);
  });
});

describe("shouldAdvanceBase", () => {
  test("未設定なら進む", () => {
    expect(shouldAdvanceBase(null, V1, false)).toBe(true);
  });

  test("より新しい版なら進む", () => {
    expect(shouldAdvanceBase(V1, V2, false)).toBe(true);
  });

  test("同じ版・古い版では進まない（単調性）", () => {
    expect(shouldAdvanceBase(V2, V2, false)).toBe(false);
    expect(shouldAdvanceBase(V2, V1, false)).toBe(false);
  });

  test("競合が未解決なら新しい版でも進まない", () => {
    expect(shouldAdvanceBase(V1, V2, true)).toBe(false);
    expect(shouldAdvanceBase(null, V1, true)).toBe(false);
  });
});
