/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Note } from "@/types.gen";
import { shouldAdoptServerDoc, usableServerDoc } from "./note-sync";

const V1 = "2026-08-29T10:00:00.000Z";
const V2 = "2026-08-29T10:00:01.000Z";
const V3 = "2026-08-29T10:00:02.000Z";

function note(updatedAt: string): Note {
  return {
    id: "note-1",
    kind: { kind: "daily" },
    content: { type: "doc", content: [] },
    date: "2026-08-29",
    created_at: V1,
    updated_at: updatedAt,
  };
}

describe("shouldAdoptServerDoc", () => {
  test("外部が書いた新しい版は差し替える", () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V3, baseUpdatedAt: V2, hasUnsaved: false }),
    ).toBe(true);
  });

  test("自分が書いた版と同じなら差し替えない（打鍵中の再マウントを避ける）", () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V2, baseUpdatedAt: V2, hasUnsaved: false }),
    ).toBe(false);
  });

  test("PUT 中の再フェッチが掴んだ書き込み前の doc は差し戻さない", () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V1, baseUpdatedAt: V2, hasUnsaved: false }),
    ).toBe(false);
  });

  test("未保存の編集があるうちは差し替えない（競合は 409 が拾う）", () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V3, baseUpdatedAt: V2, hasUnsaved: true }),
    ).toBe(false);
  });

  test("初回ロードは mount がそのまま反映するので世代を進めない", () => {
    expect(
      shouldAdoptServerDoc({ fetchedUpdatedAt: V2, baseUpdatedAt: null, hasUnsaved: false }),
    ).toBe(false);
  });
});

describe("usableServerDoc", () => {
  test("基準版が無ければそのまま採用できる", () => {
    expect(usableServerDoc(note(V1), null)).not.toBeNull();
  });

  test("自分が保存した直後の 1 世代古い cache は採用しない", () => {
    // PUT は doc を返さないので cache は V1 のまま、台帳は V2 に進んでいる状態
    expect(usableServerDoc(note(V1), V2)).toBeNull();
  });

  test("基準版と同じ版は採用できる", () => {
    expect(usableServerDoc(note(V2), V2)).not.toBeNull();
  });

  test("基準版より新しい版は採用できる", () => {
    expect(usableServerDoc(note(V3), V2)).not.toBeNull();
  });

  test("未取得（undefined）は採用しない", () => {
    expect(usableServerDoc(undefined, null)).toBeNull();
  });
});
