/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Command, Transaction } from "@milkdown/kit/prose/state";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { createContainer, nodes, schema } from "./schema";
import { containerById, parentContainerId, rangeFromIds } from "./context";
import {
  backspaceBlock,
  cursorToLineEnd,
  cursorToLineStart,
  deleteEmptyBlock,
  deleteForwardBlock,
  deleteRange,
  duplicateRange,
  exitCallout,
  exitDocEnd,
  indentRange,
  moveRange,
  outdentRange,
  splitBlock,
} from "./commands";
import { editorInputRuleList } from "./input-rules";
import { normalizerPlugin } from "./normalizer";
import { blockSelectionPlugin } from "./block-selection";
import { blockSelectionKey, selectBlocks, type BlockSelectionMeta } from "./selection-state";
import { linkHrefAt } from "./link-click";

// ---- fixture builders ----

function para(text = ""): PMNode {
  return nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}

function todo(text = "", checked = false): PMNode {
  return nodes.todo.create({ checked }, text ? schema.text(text) : undefined);
}

function bullet(text = ""): PMNode {
  return nodes.bullet.create(null, text ? schema.text(text) : undefined);
}

function heading(text: string, level = 1): PMNode {
  return nodes.heading.create({ level }, text ? schema.text(text) : undefined);
}

function code(text = ""): PMNode {
  return nodes.codeBlock.create(null, text ? schema.text(text) : undefined);
}

function callout(text = ""): PMNode {
  return nodes.callout.create(null, text ? schema.text(text) : undefined);
}

function block(id: string, content: PMNode, children: PMNode[] = []): PMNode {
  return createContainer(content, children, id);
}

function docOf(...blocks: PMNode[]): PMNode {
  return nodes.doc.create(null, nodes.blockGroup.create(null, blocks));
}

type Shape = {
  id: string | null;
  type: string;
  text: string;
  children: Shape[];
};

function shapeOf(container: PMNode): Shape {
  const content = container.child(0);
  return {
    id: container.attrs.id as string | null,
    type: content.type.name,
    text: content.textContent,
    children: container.childCount > 1 ? container.child(1).content.content.map(shapeOf) : [],
  };
}

function docShape(doc: PMNode): Shape[] {
  return doc.child(0).content.content.map(shapeOf);
}

function sh(id: string | null, type: string, text = "", children: Shape[] = []): Shape {
  return { id, type, text, children };
}

// ---- state helpers ----

function stateWithCursor(doc: PMNode, id: string, offset: number | "start" | "end"): EditorState {
  const entry = containerById(doc, id);
  if (!entry) throw new Error(`no container ${id}`);
  const content = entry.node.child(0);
  const base = entry.pos + 2;
  const pos =
    offset === "start" ? base : offset === "end" ? base + content.content.size : base + offset;
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

function run(state: EditorState, command: Command): { state: EditorState; tr: Transaction } | null {
  let captured: Transaction | undefined;
  const handled = command(state, (tr) => {
    captured = tr;
  });
  if (!handled || !captured) return null;
  return { state: state.apply(captured), tr: captured };
}

function assertInvariants(doc: PMNode): void {
  expect(() => doc.check()).not.toThrow();
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type !== nodes.blockContainer) return true;
    expect(node.attrs.id).toBeTruthy();
    ids.push(node.attrs.id as string);
    return true;
  });
  expect(new Set(ids).size).toBe(ids.length);
}

// ---- Tab / Shift+Tab（TODO.md §3） ----

describe("indentRange", () => {
  test("直前兄弟の子になる（CMD-004）", () => {
    const doc = docOf(block("A", para("A")), block("B", para("B")), block("C", para("C")));
    const state = stateWithCursor(doc, "B", "end");
    const range = rangeFromIds(state, ["B"]);
    const tr = indentRange(state, range!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([
      sh("A", "paragraph", "A", [sh("B", "paragraph", "B")]),
      sh("C", "paragraph", "C"),
    ]);
    assertInvariants(after.doc);
  });

  test("直前兄弟の既存 blockGroup を再利用する", () => {
    const doc = docOf(block("A", para("A"), [block("X", para("X"))]), block("B", para("B")));
    const state = stateWithCursor(doc, "B", "end");
    const tr = indentRange(state, rangeFromIds(state, ["B"])!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([
      sh("A", "paragraph", "A", [sh("X", "paragraph", "X"), sh("B", "paragraph", "B")]),
    ]);
    assertInvariants(after.doc);
  });

  test("直前兄弟がなければ文書を変えない（KEY-003）", () => {
    const doc = docOf(block("A", para("A")), block("B", para("B")));
    const state = stateWithCursor(doc, "A", "end");
    expect(indentRange(state, rangeFromIds(state, ["A"])!)).toBeNull();
  });

  test("連続複数 block を subtree ごと indent する（CMD-007）", () => {
    const doc = docOf(
      block("A", para("A")),
      block("B", para("B"), [block("B1", para("B1"))]),
      block("C", para("C")),
    );
    const state = stateWithCursor(doc, "A", "end");
    const tr = indentRange(state, rangeFromIds(state, ["B", "C"])!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([
      sh("A", "paragraph", "A", [
        sh("B", "paragraph", "B", [sh("B1", "paragraph", "B1")]),
        sh("C", "paragraph", "C"),
      ]),
    ]);
    assertInvariants(after.doc);
  });
});

describe("outdentRange", () => {
  test("中間 child の outdent は後続兄弟を lift 対象の子へ付け替える（§3.2 / CMD-006）", () => {
    const doc = docOf(
      block("A", para("A"), [block("B", para("B")), block("C", para("C")), block("D", para("D"))]),
      block("E", para("E")),
    );
    const state = stateWithCursor(doc, "C", "end");
    const tr = outdentRange(state, rangeFromIds(state, ["C"])!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([
      sh("A", "paragraph", "A", [sh("B", "paragraph", "B")]),
      sh("C", "paragraph", "C", [sh("D", "paragraph", "D")]),
      sh("E", "paragraph", "E"),
    ]);
    assertInvariants(after.doc);
  });

  test("末尾 child の outdent は後続付け替えなし", () => {
    const doc = docOf(block("A", para("A"), [block("B", para("B")), block("C", para("C"))]));
    const state = stateWithCursor(doc, "C", "end");
    const tr = outdentRange(state, rangeFromIds(state, ["C"])!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([
      sh("A", "paragraph", "A", [sh("B", "paragraph", "B")]),
      sh("C", "paragraph", "C"),
    ]);
    assertInvariants(after.doc);
  });

  test("全 child を outdent したら空 blockGroup を残さない（CORE-005）", () => {
    const doc = docOf(block("A", para("A"), [block("B", para("B"))]));
    const state = stateWithCursor(doc, "B", "end");
    const tr = outdentRange(state, rangeFromIds(state, ["B"])!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([sh("A", "paragraph", "A"), sh("B", "paragraph", "B")]);
    assertInvariants(after.doc);
  });

  test("root 階層では no-op（§3.2-5）", () => {
    const doc = docOf(block("A", para("A")));
    const state = stateWithCursor(doc, "A", "end");
    expect(outdentRange(state, rangeFromIds(state, ["A"])!)).toBeNull();
  });

  test("連続複数 block outdent（CMD-008）", () => {
    const doc = docOf(
      block("A", para("A"), [block("B", para("B")), block("C", para("C")), block("D", para("D"))]),
    );
    const state = stateWithCursor(doc, "B", "end");
    const tr = outdentRange(state, rangeFromIds(state, ["B", "C"])!);
    const after = state.apply(tr!);
    expect(docShape(after.doc)).toEqual([
      sh("A", "paragraph", "A"),
      sh("B", "paragraph", "B"),
      sh("C", "paragraph", "C", [sh("D", "paragraph", "D")]),
    ]);
    assertInvariants(after.doc);
  });
});

// ---- Enter（TODO.md §4） ----

describe("splitBlock", () => {
  test("paragraph 途中: 左が元 ID・children を保持し右は新 ID（§4.1）", () => {
    const doc = docOf(block("A", para("hoge"), [block("X", para("X"))]));
    const state = stateWithCursor(doc, "A", 2);
    const result = run(state, splitBlock)!;
    const shapes = docShape(result.state.doc);
    expect(shapes).toMatchObject([
      { id: "A", type: "paragraph", text: "ho", children: [{ id: "X" }] },
      { type: "paragraph", text: "ge", children: [] },
    ]);
    expect(shapes[1].id).not.toBe("A");
    assertInvariants(result.state.doc);
  });

  test("todo 分割は右側を unchecked にする（EDIT-003）", () => {
    const doc = docOf(block("A", todo("ab", true)));
    const state = stateWithCursor(doc, "A", 1);
    const result = run(state, splitBlock)!;
    const after = result.state.doc;
    expect(after.child(0).child(1).child(0).attrs.checked).toBe(false);
    expect(docShape(after)).toMatchObject([
      { id: "A", type: "todo", text: "a" },
      { type: "todo", text: "b" },
    ]);
  });

  test("heading 末尾 Enter は paragraph を作る（EDIT-002）", () => {
    const doc = docOf(block("A", heading("title")));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, splitBlock)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "heading", text: "title" },
      { type: "paragraph", text: "" },
    ]);
  });

  test("空 nested list-like は outdent（EDIT-004）", () => {
    const doc = docOf(block("A", para("A"), [block("B", bullet(""))]));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, splitBlock)!;
    expect(docShape(result.state.doc)).toEqual([sh("A", "paragraph", "A"), sh("B", "bullet", "")]);
  });

  test("空 root list-like は paragraph 化（EDIT-005）", () => {
    const doc = docOf(block("A", bullet("")));
    const state = stateWithCursor(doc, "A", "start");
    const result = run(state, splitBlock)!;
    expect(docShape(result.state.doc)).toEqual([sh("A", "paragraph", "")]);
  });

  test("callout 行末 Enter は先頭に空の子 paragraph を作る", () => {
    const doc = docOf(block("A", callout("note")));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, splitBlock)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "callout", text: "note", children: [{ type: "paragraph", text: "" }] },
    ]);
    assertInvariants(result.state.doc);
  });

  test("callout 途中 Enter はカーソル以降を子 paragraph へ移す", () => {
    const doc = docOf(block("A", callout("abcd")));
    const state = stateWithCursor(doc, "A", 2);
    const result = run(state, splitBlock)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "callout", text: "ab", children: [{ type: "paragraph", text: "cd" }] },
    ]);
  });

  test("callout 行 Enter は新しい子を既存の子の先頭に入れる", () => {
    const doc = docOf(block("A", callout("note"), [block("X", para("X"))]));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, splitBlock)!;
    expect(docShape(result.state.doc)).toMatchObject([
      {
        id: "A",
        type: "callout",
        text: "note",
        children: [
          { type: "paragraph", text: "" },
          { id: "X", type: "paragraph", text: "X" },
        ],
      },
    ]);
  });
});

describe("exitCallout", () => {
  test("callout 行から呼ぶと直後に paragraph を足す", () => {
    const doc = docOf(block("A", callout("note")));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, exitCallout)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "callout", text: "note" },
      { type: "paragraph", text: "" },
    ]);
    assertInvariants(result.state.doc);
  });

  test("callout の子から呼ぶと callout 全体の直後へ抜ける", () => {
    const doc = docOf(block("A", callout("note"), [block("X", para("child"))]));
    const state = stateWithCursor(doc, "X", "end");
    const result = run(state, exitCallout)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "callout", text: "note", children: [{ id: "X", text: "child" }] },
      { type: "paragraph", text: "" },
    ]);
  });

  test("callout 外では何もしない", () => {
    const doc = docOf(block("A", para("p")));
    const state = stateWithCursor(doc, "A", "end");
    expect(run(state, exitCallout)).toBeNull();
  });
});

// ---- Backspace / Delete（TODO.md §5） ----

describe("backspaceBlock", () => {
  test("先頭 Backspace の paragraph 化でカーソルが後続 block へ飛ばない", () => {
    const doc = docOf(block("A", bullet("ab")), block("B", para("next")));
    const state = stateWithCursor(doc, "A", "start");
    const result = run(state, backspaceBlock)!;
    expect(result.state.selection.$head.parent.textContent).toBe("ab");
    expect(result.state.selection.$head.parentOffset).toBe(0);
  });

  test("特殊型は先頭 Backspace で paragraph に戻る（ID 維持）", () => {
    const doc = docOf(block("A", todo("task", true), [block("X", para("X"))]));
    const state = stateWithCursor(doc, "A", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "task", [sh("X", "paragraph", "X")]),
    ]);
  });

  test("paragraph 同士は merge し children は結合先へ（EDIT-006 / §5.2）", () => {
    const doc = docOf(block("A", para("ab")), block("B", para("cd"), [block("X", para("X"))]));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "abcd", [sh("X", "paragraph", "X")]),
    ]);
    // cursor は結合境界
    expect(result.state.selection.head).toBe(containerById(result.state.doc, "A")!.pos + 2 + 2);
  });

  test("直前 block が子を持つなら merge せず block-select（§5.1-5 / EDIT-008）", () => {
    const doc = docOf(block("A", para("A"), [block("X", para("X"))]), block("B", para("B")));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, backspaceBlock)!;
    expect(result.state.doc.eq(doc)).toBe(true);
    const meta = result.tr.getMeta(blockSelectionKey) as BlockSelectionMeta;
    expect(meta).toEqual({ type: "set", anchorId: "A", headId: "A" });
  });

  test("空 nested paragraph（兄弟あり）は削除して nest を維持する", () => {
    const doc = docOf(block("A", para("A"), [block("B", para("b")), block("C", para(""))]));
    const state = stateWithCursor(doc, "C", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "A", [sh("B", "paragraph", "b")]),
    ]);
    // cursor は前の可視 block（B）の末尾
    expect(result.state.selection.head).toBe(containerById(result.state.doc, "B")!.pos + 2 + 1);
  });

  test("空 nested paragraph（先頭 child）は親へ吸収される", () => {
    const doc = docOf(block("A", para("A"), [block("B", para(""))]));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([sh("A", "paragraph", "A")]);
  });

  test("空 nested todo は先頭 Backspace で paragraph 化し nest を維持する", () => {
    const doc = docOf(block("A", para("A"), [block("B", todo(""))]));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "A", [sh("B", "paragraph", "")]),
    ]);
  });

  test("先頭 child の Backspace は親へ merge する", () => {
    const doc = docOf(block("A", para("ab"), [block("B", para("cd")), block("C", para("C"))]));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "abcd", [sh("C", "paragraph", "C")]),
    ]);
  });

  test("root 空 paragraph は削除して前の block 末尾へ", () => {
    const doc = docOf(block("A", para("ab")), block("B", para("")));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, backspaceBlock)!;
    expect(docShape(result.state.doc)).toEqual([sh("A", "paragraph", "ab")]);
  });
});

describe("deleteForwardBlock", () => {
  test("block 末尾で次の兄弟と merge（EDIT-007）", () => {
    const doc = docOf(block("A", para("ab")), block("B", para("cd")));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, deleteForwardBlock)!;
    expect(docShape(result.state.doc)).toEqual([sh("A", "paragraph", "abcd")]);
  });

  test("子を持つ block は先頭 child を親へ merge", () => {
    const doc = docOf(block("A", para("ab"), [block("B", para("cd"), [block("X", para("X"))])]));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, deleteForwardBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "abcd", [sh("X", "paragraph", "X")]),
    ]);
  });

  test("atom 隣接では block-select に移行（§5.3）", () => {
    const doc = docOf(block("A", para("ab")), block("D", nodes.divider.create()));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, deleteForwardBlock)!;
    expect(result.state.doc.eq(doc)).toBe(true);
    const meta = result.tr.getMeta(blockSelectionKey) as BlockSelectionMeta;
    expect(meta).toEqual({ type: "set", anchorId: "D", headId: "D" });
  });
});

describe("deleteEmptyBlock", () => {
  test("空 block を削除しカーソルは次行の先頭へ", () => {
    const doc = docOf(block("A", para("ab")), block("B", para()), block("C", para("cd")));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, deleteEmptyBlock)!;
    expect(docShape(result.state.doc)).toEqual([
      sh("A", "paragraph", "ab"),
      sh("C", "paragraph", "cd"),
    ]);
    const $head = result.state.selection.$head;
    expect($head.parent.textContent).toBe("cd");
    expect($head.parentOffset).toBe(0);
    assertInvariants(result.state.doc);
  });

  test("末尾の空 block を削除すると前行の末尾へ", () => {
    const doc = docOf(block("A", para("ab")), block("B", para()));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, deleteEmptyBlock)!;
    expect(docShape(result.state.doc)).toEqual([sh("A", "paragraph", "ab")]);
    expect(result.state.selection.$head.parent.textContent).toBe("ab");
  });

  test("唯一の空 block では空 paragraph を残す", () => {
    const doc = docOf(block("A", para()));
    const state = stateWithCursor(doc, "A", "start");
    const result = run(state, deleteEmptyBlock)!;
    const shapes = docShape(result.state.doc);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].type).toBe("paragraph");
    expect(shapes[0].text).toBe("");
    assertInvariants(result.state.doc);
  });

  test("非空 block では何もしない（ネイティブ前方削除へフォールスルー）", () => {
    const doc = docOf(block("A", para("ab")));
    const state = stateWithCursor(doc, "A", "start");
    expect(run(state, deleteEmptyBlock)).toBeNull();
  });

  test("子持ちの空 block は対象外", () => {
    const doc = docOf(block("A", para(), [block("B", para("cd"))]));
    const state = stateWithCursor(doc, "A", "start");
    expect(run(state, deleteEmptyBlock)).toBeNull();
  });

  test("空 code block は対象外", () => {
    const doc = docOf(block("A", code()), block("B", para("cd")));
    const state = stateWithCursor(doc, "A", "start");
    expect(run(state, deleteEmptyBlock)).toBeNull();
  });
});

// ---- block selection 操作（TODO.md §7.2） ----

describe("deleteRange / duplicateRange / moveRange", () => {
  test("subtree 削除。root が空になったら空 paragraph を残す（§1.5 / SEL-009）", () => {
    const doc = docOf(block("A", para("A"), [block("X", para("X"))]));
    const state = stateWithCursor(doc, "A", "end");
    const after = state.apply(deleteRange(state, rangeFromIds(state, ["A"])!));
    expect(docShape(after.doc)).toMatchObject([{ type: "paragraph", text: "", children: [] }]);
    assertInvariants(after.doc);
  });

  test("複製は全 ID を再発行する（SEL-010 / §10.3）", () => {
    const doc = docOf(block("A", para("A"), [block("X", para("X"))]), block("B", para("B")));
    const state = stateWithCursor(doc, "A", "end");
    const after = state.apply(duplicateRange(state, rangeFromIds(state, ["A"])!));
    const shapes = docShape(after.doc);
    expect(shapes).toMatchObject([
      { id: "A", text: "A", children: [{ id: "X" }] },
      { text: "A", children: [{ text: "X" }] },
      { id: "B", text: "B" },
    ]);
    expect(shapes[1].id).not.toBe("A");
    expect(shapes[1].children[0].id).not.toBe("X");
    assertInvariants(after.doc);
  });

  test("Mod-Shift-Arrow の move は兄弟と入れ替える", () => {
    const doc = docOf(block("A", para("A")), block("B", para("B")), block("C", para("C")));
    const state = stateWithCursor(doc, "B", "end");
    const up = state.apply(moveRange(state, rangeFromIds(state, ["B"])!, "up")!);
    expect(docShape(up.doc).map((s) => s.id)).toEqual(["B", "A", "C"]);
    const down = state.apply(moveRange(state, rangeFromIds(state, ["B"])!, "down")!);
    expect(docShape(down.doc).map((s) => s.id)).toEqual(["A", "C", "B"]);
  });
});

// ---- input rules（TODO.md §6） ----

type RuleInternals = {
  match: RegExp;
  handler: (
    state: EditorState,
    match: RegExpMatchArray,
    start: number,
    end: number,
  ) => Transaction | null;
};

function fireRule(state: EditorState, typed: string): EditorState | null {
  const $head = state.selection.$head;
  const textBefore = $head.parent.textBetween(0, $head.parentOffset, undefined, "￼") + typed;
  for (const rule of editorInputRuleList()) {
    const { match, handler } = rule as unknown as RuleInternals;
    const found = match.exec(textBefore);
    if (!found) continue;
    const start = state.selection.head - (found[0].length - typed.length);
    const tr = handler(state, found, start, state.selection.head);
    if (tr) return state.apply(tr);
  }
  return null;
}

describe("input rules", () => {
  const cases: Array<[string, string, string, Record<string, unknown>]> = [
    ["[]", " ", "todo", { checked: false }],
    ["[x]", " ", "todo", { checked: true }],
    ["-[]", " ", "todo", { checked: false }],
    ["- [ ]", " ", "todo", { checked: false }],
    ["* [ ]", " ", "todo", { checked: false }],
    ["-", " ", "bullet", {}],
    ["1.", " ", "numbered", { style: "decimal" }],
    ["a.", " ", "numbered", { style: "lower-alpha" }],
    ["i.", " ", "numbered", { style: "lower-roman" }],
    ["##", " ", "heading", { level: 2 }],
    ["###", " ", "heading", { level: 3 }],
    [">", " ", "toggle", { open: true }],
    ['"', " ", "quote", {}],
    ["--", "-", "divider", {}],
    ["``", "`", "codeBlock", {}],
  ];

  for (const [before, typed, type, attrs] of cases) {
    test(`"${before}" + "${typed}" → ${type}`, () => {
      const doc = docOf(block("A", para(before)));
      const state = stateWithCursor(doc, "A", "end");
      const after = fireRule(state, typed);
      expect(after).not.toBeNull();
      const shape = docShape(after!.doc)[0];
      expect(shape.type).toBe(type);
      expect(shape.text).toBe("");
      expect(shape.id).toBe("A");
      const content = after!.doc.child(0).child(0).child(0);
      for (const [key, value] of Object.entries(attrs)) {
        expect(content.attrs[key]).toBe(value);
      }
    });
  }

  test("空 bullet 内の `[] ` は同じ ID のまま todo になる（RULE-009）", () => {
    const doc = docOf(block("A", bullet("[]"), [block("X", para("X"))]));
    const state = stateWithCursor(doc, "A", "end");
    const after = fireRule(state, " ")!;
    expect(docShape(after.doc)).toEqual([sh("A", "todo", "", [sh("X", "paragraph", "X")])]);
  });

  test("`# ` は発火しない（H1 廃止）", () => {
    const doc = docOf(block("A", para("#")));
    const state = stateWithCursor(doc, "A", "end");
    expect(fireRule(state, " ")).toBeNull();
  });

  test("divider 変換は直後に空 paragraph を作ってカーソルを移す", () => {
    const doc = docOf(block("A", para("--")), block("B", para("next")));
    const state = stateWithCursor(doc, "A", "end");
    const after = fireRule(state, "-")!;
    expect(docShape(after.doc)).toMatchObject([
      { id: "A", type: "divider" },
      { type: "paragraph", text: "" },
      { id: "B", type: "paragraph", text: "next" },
    ]);
    expect(after.selection.$head.parent.type).toBe(nodes.paragraph);
    expect(after.selection.$head.parent.textContent).toBe("");
  });

  test("content 途中では発火しない（RULE-011）", () => {
    const doc = docOf(block("A", para("x[]")));
    const state = stateWithCursor(doc, "A", "end");
    expect(fireRule(state, " ")).toBeNull();
  });

  test("code block では発火しない", () => {
    const doc = docOf(block("A", code("#")));
    const state = stateWithCursor(doc, "A", "end");
    expect(fireRule(state, " ")).toBeNull();
  });

  test("後続 block があってもカーソルは変換した block 内に留まる", () => {
    const doc = docOf(block("A", para("-")), block("B", heading("Hello")));
    const state = stateWithCursor(doc, "A", "end");
    const after = fireRule(state, " ")!;
    expect(docShape(after.doc)[0]).toMatchObject({ id: "A", type: "bullet" });
    expect(after.selection.$head.parent.type).toBe(nodes.bullet);
  });

  test("`**text**` → bold mark", () => {
    const doc = docOf(block("A", para("**bold*")));
    const state = stateWithCursor(doc, "A", "end");
    const after = fireRule(state, "*")!;
    const content = after.doc.child(0).child(0).child(0);
    expect(content.textContent).toBe("bold");
    expect(content.firstChild!.marks.some((m) => m.type === schema.marks.bold)).toBe(true);
  });
});

// ---- Ctrl-a / Ctrl-e ----

describe("cursorToLineStart / cursorToLineEnd", () => {
  test("text block では content の先頭・末尾へ移動する", () => {
    const doc = docOf(block("A", para("hello")));
    const state = stateWithCursor(doc, "A", 3);
    const start = run(state, cursorToLineStart)!;
    expect(start.state.selection.head).toBe(containerById(doc, "A")!.pos + 2);
    const end = run(state, cursorToLineEnd)!;
    expect(end.state.selection.head).toBe(containerById(doc, "A")!.pos + 2 + 5);
  });

  test("code block では現在行の行頭・行末へ移動する", () => {
    const doc = docOf(block("A", code("ab\ncd\nef")));
    const state = stateWithCursor(doc, "A", 4); // "cd" の途中
    const base = containerById(doc, "A")!.pos + 2;
    const start = run(state, cursorToLineStart)!;
    expect(start.state.selection.head).toBe(base + 3);
    const end = run(state, cursorToLineEnd)!;
    expect(end.state.selection.head).toBe(base + 5);
  });
});

// ---- normalizer（TODO.md §12.2） ----

describe("normalizer", () => {
  test("duplicate ID を再発行する（CORE-003）", () => {
    const doc = docOf(block("A", para("A")));
    const state = EditorState.create({ doc, plugins: [normalizerPlugin()] });
    const dup = block("A", para("dup"));
    const after = state.apply(state.tr.insert(doc.content.size - 1, dup));
    assertInvariants(after.doc);
    const shapes = docShape(after.doc);
    expect(shapes[0].id).toBe("A");
    expect(shapes[1].id).not.toBe("A");
  });

  test("missing ID を補う（CORE-001/003）", () => {
    const doc = docOf(block("A", para("A")));
    const state = EditorState.create({ doc, plugins: [normalizerPlugin()] });
    const anon = nodes.blockContainer.create(null, [para("anon")]);
    const after = state.apply(state.tr.insert(doc.content.size - 1, anon));
    assertInvariants(after.doc);
  });
});

// ---- linkHrefAt（link mark クリックの href 解決） ----

describe("linkHrefAt", () => {
  const link = schema.marks.link.create({ href: "https://example.com" });
  const doc = docOf(
    block("A", nodes.paragraph.create(null, [schema.text("ab", [link]), schema.text("cd")])),
  );
  const textStart = containerById(doc, "A")!.pos + 2;

  test("link mark 上の位置は href を返す", () => {
    expect(linkHrefAt(doc, textStart)).toBe("https://example.com");
    expect(linkHrefAt(doc, textStart + 1)).toBe("https://example.com");
  });

  test("link mark 外の位置は null", () => {
    expect(linkHrefAt(doc, textStart + 3)).toBeNull();
  });
});

// ---- parentContainerId（Cmd-A エスカレーションの階層クエリ） ----

describe("parentContainerId", () => {
  const doc = docOf(
    block("A", para("xxx"), [block("B", para("yyy"), [block("C", para("zzz"))])]),
    block("D", para("aaa")),
  );

  test("ネストした block は1階層ずつ親へ辿れる", () => {
    expect(parentContainerId(doc, "C")).toBe("B");
    expect(parentContainerId(doc, "B")).toBe("A");
  });

  test("トップレベル block は null", () => {
    expect(parentContainerId(doc, "A")).toBeNull();
    expect(parentContainerId(doc, "D")).toBeNull();
  });

  test("存在しない id は null", () => {
    expect(parentContainerId(doc, "nope")).toBeNull();
  });
});

// ---- exitDocEnd（Ctrl-n の下端脱出） ----

function bookmark(): PMNode {
  return nodes.bookmark.create({ href: "https://example.com" });
}

function stateWithBlockSelection(doc: PMNode, id: string): EditorState {
  const base = EditorState.create({ doc, plugins: [blockSelectionPlugin()] });
  return base.apply(selectBlocks(base.tr, id, id));
}

describe("exitDocEnd", () => {
  test("末尾の非空 block では下に空 paragraph を足してカーソルを移す", () => {
    const doc = docOf(block("A", para("ab")));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, exitDocEnd)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "paragraph", text: "ab" },
      { type: "paragraph", text: "" },
    ]);
    assertInvariants(result.state.doc);
    expect(result.state.selection.head).toBe(doc.content.size - 1 + 2);
  });

  test("末尾が空 paragraph ならカーソルを移すだけで何も足さない", () => {
    const doc = docOf(block("A", para("ab")), block("B", para("")));
    const state = stateWithCursor(doc, "B", "start");
    const result = run(state, exitDocEnd)!;
    expect(result.state.doc.eq(doc)).toBe(true);
    expect(result.state.selection.head).toBe(containerById(doc, "B")!.pos + 2);
  });

  test("下にカーソルを置ける block が残っていれば false（通常の下移動に任せる）", () => {
    const doc = docOf(block("A", para("ab")), block("B", para("cd")));
    const state = stateWithCursor(doc, "A", "end");
    expect(run(state, exitDocEnd)).toBeNull();
  });

  test("下が atom block だけなら末尾に空 paragraph を足す（bookmark 詰み回避）", () => {
    const doc = docOf(block("A", para("ab")), block("B", bookmark()));
    const state = stateWithCursor(doc, "A", "end");
    const result = run(state, exitDocEnd)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "paragraph", text: "ab" },
      { id: "B", type: "bookmark" },
      { type: "paragraph", text: "" },
    ]);
    assertInvariants(result.state.doc);
    expect(result.state.selection.head).toBe(doc.content.size - 1 + 2);
  });

  test("末尾 bookmark の block selection 中でも末尾に空 paragraph を足す", () => {
    const doc = docOf(block("A", para("ab")), block("B", bookmark()));
    const state = stateWithBlockSelection(doc, "B");
    const result = run(state, exitDocEnd)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "paragraph", text: "ab" },
      { id: "B", type: "bookmark" },
      { type: "paragraph", text: "" },
    ]);
    expect(blockSelectionKey.getState(result.state)?.selectedIds).toEqual([]);
    expect(result.state.selection.$head.parent.type.name).toBe("paragraph");
  });

  test("nested な末尾 block からは root level に空 paragraph を足す", () => {
    const doc = docOf(block("A", para("A"), [block("X", para("x"))]));
    const state = stateWithCursor(doc, "X", "end");
    const result = run(state, exitDocEnd)!;
    expect(docShape(result.state.doc)).toMatchObject([
      { id: "A", type: "paragraph", text: "A", children: [{ id: "X", type: "paragraph" }] },
      { type: "paragraph", text: "" },
    ]);
    assertInvariants(result.state.doc);
  });
});
