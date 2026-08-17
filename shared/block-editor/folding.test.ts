/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { nodes } from "./schema";
import { visibleContainers } from "./context";
import {
  block,
  callout,
  contentPos,
  divider,
  docOf,
  heading,
  para,
  posOf,
  toggle,
} from "./test-fixtures";
import {
  expandedContent,
  expandedHeading,
  expandedHeadingsDeep,
  foldedIndexes,
  isCollapsedContainer,
  isPosHidden,
  resolveFoldTarget,
  revealPos,
} from "./folding";

function rootFolds(doc: PMNode): number[] {
  return [...foldedIndexes(doc.child(0))];
}

/** id の block の content 内 offset を解決する */
function resolveIn(doc: PMNode, id: string, offset: number | "end" = 0) {
  return doc.resolve(contentPos(doc, id, offset));
}

/** id を可視にするために revealPos が開いた block の id（doc 順） */
function opensFor(doc: PMNode, id: string): string[] {
  const tr = EditorState.create({ doc }).tr;
  revealPos(tr, posOf(doc, id));
  const opened: string[] = [];
  // setNodeAttribute は nodeSize を変えないので、前後の doc を同じ pos で比べられる
  doc.descendants((node, pos) => {
    if (node.type !== nodes.blockContainer) return true;
    const after = tr.doc.nodeAt(pos);
    if (after && isCollapsedContainer(node) && !isCollapsedContainer(after))
      opened.push(node.attrs.id as string);
    return true;
  });
  return opened;
}

// ---- foldedIndexes ----

describe("foldedIndexes", () => {
  test("折りたたんだ h2 は次の h2 の手前まで隠す", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("p2", para("2")),
      block("h2b", heading("B", 2)),
      block("p3", para("3")),
    );
    expect(rootFolds(doc)).toEqual([1, 2]);
  });

  test("h2 を畳むと配下の h3 セクションごと隠れる", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("h3a", heading("A-1", 3)),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
    );
    expect(rootFolds(doc)).toEqual([1, 2]);
  });

  test("h3 は次の h3 の手前まで", () => {
    const doc = docOf(
      block("h3a", heading("A", 3, true)),
      block("p1", para("1")),
      block("h3b", heading("B", 3)),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1]);
  });

  test("h3 の範囲は上位の h2 でも切れる", () => {
    const doc = docOf(
      block("h3a", heading("A", 3, true)),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1]);
  });

  test("h1 はセクション境界として h2 の範囲を切る", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("h1b", heading("B", 1)),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1]);
  });

  test("折りたたまれた h1 は畳めないので何も隠さない", () => {
    const doc = docOf(
      block("h1a", heading("A", 1, true)),
      block("p1", para("1")),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([]);
  });

  test("境界となる heading がなければ末尾まで隠す", () => {
    const doc = docOf(
      block("p0", para("0")),
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([2, 3]);
  });

  test("展開中の heading は何も隠さない", () => {
    const doc = docOf(block("h2a", heading("A", 2)), block("p1", para("1")));
    expect(rootFolds(doc)).toEqual([]);
  });

  test("入れ子の collapsed h3 は h2 の範囲に吸収される（和集合）", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("h3a", heading("A-1", 3, true)),
      block("p2", para("2")),
      block("h2b", heading("B", 2)),
      block("p3", para("3")),
    );
    expect(rootFolds(doc)).toEqual([1, 2, 3]);
  });

  test("divider は h2 の範囲を切り、divider 自身と以降は可視", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("d", divider()),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1]);
  });

  test("divider は最内の h3 section だけを終端し、h2 の範囲には留まる", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("h3a", heading("A-1", 3, true)),
      block("p1", para("1")),
      block("d", divider()),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([2]);
  });

  test("h3 内に divider があっても h2 を畳めば末尾まで隠れる", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("h3a", heading("A-1", 3)),
      block("p1", para("1")),
      block("d", divider()),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1, 2, 3, 4]);
  });

  test("本文間の空行は最内の h3 section を終端し、自身は一緒に隠れる", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("h3a", heading("A-1", 3, true)),
      block("p1", para("1")),
      block("gap", para()),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([2, 3]);
  });

  test("空行で h3 が切れても h2 を畳めば末尾まで隠れる", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("h3a", heading("A-1", 3)),
      block("p1", para("1")),
      block("gap", para()),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1, 2, 3, 4]);
  });

  test("heading 直後の空行は余白として section 内に留まる", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("gap1", para()),
      block("p1", para("1")),
      block("p2", para("2")),
      block("gap2", para()),
      block("gap3", para()),
      block("p3", para("3")),
    );
    // gap2 が section を終端して一緒に隠れ、gap3 以降は可視
    expect(rootFolds(doc)).toEqual([1, 2, 3, 4]);
  });

  test("sub-heading 直前の空行は区切りにならない", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("gap", para()),
      block("h3a", heading("A-1", 3)),
      block("p2", para("2")),
    );
    expect(rootFolds(doc)).toEqual([1, 2, 3, 4]);
  });

  test("divider に隣接する空行は divider に従属し、二重に終端しない", () => {
    const doc = docOf(
      block("h3a", heading("A", 3, true)),
      block("p1", para("1")),
      block("gap1", para()),
      block("d", divider()),
      block("gap2", para()),
      block("p2", para("2")),
    );
    // gap1 は h3 の中身として隠れ、divider が h3 を終端。gap2 以降は可視
    expect(rootFolds(doc)).toEqual([1, 2]);
  });

  test("連続した空行は 1 行につき 1 レベル終端する", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("h3a", heading("A-1", 3)),
      block("p1", para("1")),
      block("gap1", para()),
      block("gap2", para()),
      block("p2", para("2")),
    );
    // gap1 が h3 を、gap2 が h2 を終端するので p2 は h2 の外
    expect(rootFolds(doc)).toEqual([1, 2, 3, 4]);
  });

  test("h2 を展開しても内側の collapsed h3 は畳まれたまま", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("p1", para("1")),
      block("h3a", heading("A-1", 3, true)),
      block("p2", para("2")),
      block("h2b", heading("B", 2)),
    );
    expect(rootFolds(doc)).toEqual([3]);
  });
});

// ---- isCollapsedContainer / expandedContent ----

describe("isCollapsedContainer", () => {
  test("閉じた toggle / collapsed な callout・heading を検出する", () => {
    expect(isCollapsedContainer(block("a", toggle("t", false)))).toBe(true);
    expect(isCollapsedContainer(block("b", callout("c", true)))).toBe(true);
    expect(isCollapsedContainer(block("c", heading("h", 2, true)))).toBe(true);
  });

  test("展開中・折りたたみ非対応の block は false", () => {
    expect(isCollapsedContainer(block("a", toggle("t")))).toBe(false);
    expect(isCollapsedContainer(block("b", callout("c")))).toBe(false);
    expect(isCollapsedContainer(block("c", heading("h", 2)))).toBe(false);
    expect(isCollapsedContainer(block("d", heading("h", 1, true)))).toBe(false);
    expect(isCollapsedContainer(block("e", para("p")))).toBe(false);
  });
});

describe("expandedContent", () => {
  test("折りたたまれた content を開く", () => {
    expect(expandedContent(toggle("t", false)).attrs.open).toBe(true);
    expect(expandedContent(callout("c", true)).attrs.collapsed).toBe(false);
    expect(expandedContent(heading("h", 2, true)).attrs.collapsed).toBe(false);
  });

  test("開いている content は同一参照を返す", () => {
    const open = heading("h", 2);
    expect(expandedContent(open)).toBe(open);
    const h1 = heading("h", 1, true);
    expect(expandedContent(h1)).toBe(h1);
  });

  test("inline content を保持する", () => {
    expect(expandedContent(heading("Title", 2, true)).textContent).toBe("Title");
  });
});

// ---- isPosHidden ----

describe("isPosHidden", () => {
  test("collapsed heading の支配下にある兄弟は不可視", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
    );
    expect(isPosHidden(doc, resolveIn(doc, "p1").pos)).toBe(true);
    expect(isPosHidden(doc, resolveIn(doc, "h2a").pos)).toBe(false);
    expect(isPosHidden(doc, resolveIn(doc, "h2b").pos)).toBe(false);
  });

  test("collapsed callout / 閉じた toggle の子は不可視", () => {
    const doc = docOf(
      block("c", callout("c", true), [block("cx", para("x"))]),
      block("t", toggle("t", false), [block("tx", para("x"))]),
    );
    expect(isPosHidden(doc, resolveIn(doc, "cx").pos)).toBe(true);
    expect(isPosHidden(doc, resolveIn(doc, "tx").pos)).toBe(true);
    expect(isPosHidden(doc, resolveIn(doc, "c").pos)).toBe(false);
  });

  test("collapsed heading の構造上の子も不可視", () => {
    const doc = docOf(block("h", heading("A", 2, true), [block("hx", para("x"))]));
    expect(isPosHidden(doc, resolveIn(doc, "hx").pos)).toBe(true);
  });
});

// ---- resolveFoldTarget ----

describe("resolveFoldTarget", () => {
  test("heading 上のカーソルは自分自身", () => {
    const doc = docOf(block("h2a", heading("A", 2)), block("p1", para("1")));
    expect(resolveFoldTarget(resolveIn(doc, "h2a"))?.containerPos).toBe(posOf(doc, "h2a"));
  });

  test("heading 配下の段落は支配 heading", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("p1", para("1")),
      block("p2", para("2")),
    );
    expect(resolveFoldTarget(resolveIn(doc, "p2"))?.containerPos).toBe(posOf(doc, "h2a"));
  });

  test("直近の heading が h1 ならその group には対象なし", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("h1b", heading("B", 1)),
      block("p1", para("1")),
    );
    expect(resolveFoldTarget(resolveIn(doc, "p1"))).toBeNull();
  });

  test("heading より前の段落には対象なし", () => {
    const doc = docOf(block("p0", para("0")), block("h2a", heading("A", 2)));
    expect(resolveFoldTarget(resolveIn(doc, "p0"))).toBeNull();
  });

  test("divider を挟んだ段落は前方の heading の対象外", () => {
    const doc = docOf(block("h2a", heading("A", 2)), block("d", divider()), block("p1", para("1")));
    expect(resolveFoldTarget(resolveIn(doc, "p1"))).toBeNull();
  });

  test("h3 内の divider の後ろでは h3 ではなく h2 が対象", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("h3a", heading("A-1", 3)),
      block("d", divider()),
      block("p1", para("1")),
    );
    expect(resolveFoldTarget(resolveIn(doc, "p1"))?.containerPos).toBe(posOf(doc, "h2a"));
  });

  test("終端空行の後ろの段落は前方の heading の対象外、空行自身は section 内", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("p1", para("1")),
      block("gap", para()),
      block("p2", para("2")),
    );
    expect(resolveFoldTarget(resolveIn(doc, "p2"))).toBeNull();
    expect(resolveFoldTarget(resolveIn(doc, "gap"))?.containerPos).toBe(posOf(doc, "h2a"));
  });

  test("h3 を終端する空行の後ろでは h2 が対象", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("h3a", heading("A-1", 3)),
      block("p1", para("1")),
      block("gap", para()),
      block("p2", para("2")),
    );
    expect(resolveFoldTarget(resolveIn(doc, "p2"))?.containerPos).toBe(posOf(doc, "h2a"));
  });

  test("callout / toggle の子は最寄りの親が対象", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("c", callout("c"), [block("cx", para("x"))]),
      block("t", toggle("t"), [block("tx", para("x"))]),
    );
    expect(resolveFoldTarget(resolveIn(doc, "cx"))?.containerPos).toBe(posOf(doc, "c"));
    expect(resolveFoldTarget(resolveIn(doc, "tx"))?.containerPos).toBe(posOf(doc, "t"));
  });

  test("内側の group に heading がなければ外側の深度へ遡る", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("p1", para("1"), [block("nested", para("n"))]),
    );
    expect(resolveFoldTarget(resolveIn(doc, "nested"))?.containerPos).toBe(posOf(doc, "h2a"));
  });

  test("内側の group の heading が優先される", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("p1", para("1"), [block("h3in", heading("B", 3)), block("nested", para("n"))]),
    );
    expect(resolveFoldTarget(resolveIn(doc, "nested"))?.containerPos).toBe(posOf(doc, "h3in"));
  });
});

// ---- revealPos ----

describe("revealPos", () => {
  test("可視な block には何もしない", () => {
    const doc = docOf(block("h2a", heading("A", 2)), block("p1", para("1")));
    expect(opensFor(doc, "p1")).toEqual([]);
  });

  test("支配 heading を開く", () => {
    const doc = docOf(block("h2a", heading("A", 2, true)), block("p1", para("1")));
    expect(opensFor(doc, "p1")).toEqual(["h2a"]);
  });

  test("h2 / h3 が二重に畳まれていれば両方開く", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("h3a", heading("A-1", 3, true)),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
    );
    expect(opensFor(doc, "p1")).toEqual(["h2a", "h3a"]);
  });

  test("h3 が開いていれば h2 だけ開く", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("h3a", heading("A-1", 3)),
      block("p1", para("1")),
    );
    expect(opensFor(doc, "p1")).toEqual(["h2a"]);
  });

  test("祖先の toggle / callout と支配 heading をまとめて開く", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("t", toggle("t", false), [
        block("c", callout("c", true), [block("target", para("x"))]),
      ]),
    );
    expect(opensFor(doc, "target")).toEqual(["h2a", "t", "c"]);
  });

  test("対象自身の折りたたみは開かない", () => {
    const doc = docOf(block("c", callout("c", true), [block("cx", para("x"))]));
    expect(opensFor(doc, "c")).toEqual([]);
  });
});

describe("expandedHeading", () => {
  test("heading だけ畳みを解き、callout / toggle は触らない", () => {
    expect(expandedHeading(heading("h", 2, true)).attrs.collapsed).toBe(false);
    const c = callout("c", true);
    expect(expandedHeading(c)).toBe(c);
    const t = toggle("t", false);
    expect(expandedHeading(t)).toBe(t);
  });

  test("expandedHeadingsDeep は入れ子の heading にも届き、他の畳みは残す", () => {
    const subtree = block("root", callout("c", true), [
      block("h", heading("A", 2, true), [block("inner", heading("B", 3, true))]),
      block("t", toggle("t", false)),
    ]);
    const out = expandedHeadingsDeep(subtree);
    const attrs = (n: PMNode, path: number[]) =>
      path.reduce<PMNode>((acc, i) => acc.child(i), n).child(0).attrs;
    // callout / toggle の畳みは持ち回っても子が一緒に動くので維持
    expect(out.child(0).attrs.collapsed).toBe(true);
    expect(attrs(out, [1, 1]).open).toBe(false);
    // heading は貼り先の兄弟を隠すので必ず開く
    expect(attrs(out, [1, 0]).collapsed).toBe(false);
    expect(attrs(out, [1, 0, 1, 0]).collapsed).toBe(false);
    expect(out.attrs.id).toBe("root");
  });
});

// ---- visibleContainers（キーボードナビの走査元） ----

describe("visibleContainers", () => {
  test("collapsed heading の支配範囲と構造上の子を飛ばす", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true), [block("child", para("c"))]),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
      block("p2", para("2")),
    );
    expect(visibleContainers(doc).map((v) => v.id)).toEqual(["h2a", "h2b", "p2"]);
  });

  test("展開すれば全て戻る", () => {
    const doc = docOf(
      block("h2a", heading("A", 2)),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
    );
    expect(visibleContainers(doc).map((v) => v.id)).toEqual(["h2a", "p1", "h2b"]);
  });

  test("閉じた toggle / collapsed callout の子を飛ばす（既存挙動）", () => {
    const doc = docOf(
      block("t", toggle("t", false), [block("tx", para("x"))]),
      block("c", callout("c", true), [block("cx", para("x"))]),
      block("p1", para("1")),
    );
    expect(visibleContainers(doc).map((v) => v.id)).toEqual(["t", "c", "p1"]);
  });

  test("pos は doc 上の実位置を保つ", () => {
    const doc = docOf(
      block("h2a", heading("A", 2, true)),
      block("p1", para("1")),
      block("h2b", heading("B", 2)),
    );
    for (const entry of visibleContainers(doc)) expect(entry.pos).toBe(posOf(doc, entry.id));
  });
});
