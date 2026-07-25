/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { EssayStatus, NoteSummary } from "@/types.gen";
import { ESSAY_TABS, otherEssayTab, splitEssaysByStatus } from "./support";

function essay(id: string, status: EssayStatus): NoteSummary {
  return {
    id,
    kind: {
      kind: "essay",
      title: id,
      status,
      // 分類には使われないが、サーバが返す形に合わせておく
      next_status: status === "writing" ? "finished" : "writing",
    },
    date: "2026-07-21",
    preview: "",
    created_at: "2026-07-21T00:00:00Z",
    updated_at: "2026-07-21T00:00:00Z",
  };
}

function daily(id: string): NoteSummary {
  return {
    id,
    kind: { kind: "daily" },
    date: "2026-07-21",
    preview: "",
    created_at: "2026-07-21T00:00:00Z",
    updated_at: "2026-07-21T00:00:00Z",
  };
}

describe("splitEssaysByStatus", () => {
  test("未取得は未取得のまま返す", () => {
    expect(splitEssaysByStatus(null)).toBeNull();
  });

  test("空リストでも両 status のキーが存在する", () => {
    expect(splitEssaysByStatus([])).toEqual({ writing: [], finished: [] });
  });

  test("status ごとに振り分け、各バケット内の順序を保つ", () => {
    const groups = splitEssaysByStatus([
      essay("w1", "writing"),
      essay("f1", "finished"),
      essay("w2", "writing"),
      essay("f2", "finished"),
    ]);
    expect(groups?.writing.map((s) => s.id)).toEqual(["w1", "w2"]);
    expect(groups?.finished.map((s) => s.id)).toEqual(["f1", "f2"]);
  });

  test("essay 以外の summary はどちらのバケットにも入れない", () => {
    expect(splitEssaysByStatus([daily("d1"), essay("w1", "writing")])).toEqual({
      writing: [essay("w1", "writing")],
      finished: [],
    });
  });
});

describe("ESSAY_TABS", () => {
  test("サイドバーの描画順は writing → finished", () => {
    expect(ESSAY_TABS).toEqual(["writing", "finished"]);
  });

  test("splitEssaysByStatus の全キーがタブとして到達できる", () => {
    const groups = splitEssaysByStatus([]);
    expect(Object.keys(groups ?? {}).sort()).toEqual([...ESSAY_TABS].sort());
  });
});

describe("otherEssayTab", () => {
  test("同じキーを 2 回押すと元のタブに戻る", () => {
    for (const tab of ESSAY_TABS) {
      expect(otherEssayTab(tab)).not.toBe(tab);
      expect(otherEssayTab(otherEssayTab(tab))).toBe(tab);
    }
  });
});
