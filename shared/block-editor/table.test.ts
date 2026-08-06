/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Command } from "@milkdown/kit/prose/state";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { nodes } from "./schema";
import {
  getTableCellContext,
  tableEnter,
  tableHardBreak,
  tableNextCell,
  tablePrevCell,
} from "./table";
import { exitDocEnd, exitDocStart, splitBlock } from "./commands";
import { blocksToPlainText } from "./clipboard";
import { block, docOf, tableOf } from "./test-fixtures";

function cellPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === nodes.tableCell) out.push(pos);
    return true;
  });
  return out;
}

/** n 番目（文書順）のセル先頭にカーソルを置いた state */
function stateInCell(doc: PMNode, cellIndex: number, offset = 0): EditorState {
  const pos = cellPositions(doc)[cellIndex];
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos + 1 + offset) });
}

function run(state: EditorState, command: Command): { state: EditorState; handled: boolean } {
  let next = state;
  const handled = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { state: next, handled };
}

const twoByTwo = () =>
  docOf(
    block(
      "T",
      tableOf([
        ["a", "b"],
        ["c", "d"],
      ]),
    ),
  );

describe("getTableCellContext", () => {
  test("行・列 index と table / container の位置を解決する", () => {
    const doc = twoByTwo();
    const ctx = getTableCellContext(stateInCell(doc, 3).selection.$from);
    expect(ctx).not.toBeNull();
    expect(ctx!.rowIndex).toBe(1);
    expect(ctx!.cellIndex).toBe(1);
    expect(ctx!.cellNode.textContent).toBe("d");
    expect(doc.nodeAt(ctx!.tablePos)?.type).toBe(nodes.table);
    expect(doc.nodeAt(ctx!.containerPos)?.type).toBe(nodes.blockContainer);
  });

  test("table 外では null", () => {
    const doc = twoByTwo();
    expect(getTableCellContext(doc.resolve(0))).toBeNull();
  });
});

describe("tableNextCell / tablePrevCell", () => {
  test("Tab は次のセルへ（行またぎも含む）", () => {
    const doc = twoByTwo();
    const { state, handled } = run(stateInCell(doc, 1), tableNextCell);
    expect(handled).toBe(true);
    expect(state.selection.$from.parent.textContent).toBe("c");
  });

  test("最終セルの Tab は空行を追加して先頭セルへ", () => {
    const doc = twoByTwo();
    const { state } = run(stateInCell(doc, 3), tableNextCell);
    const table = state.doc.child(0).child(0).child(0);
    expect(table.childCount).toBe(3);
    expect(table.child(2).childCount).toBe(2);
    const ctx = getTableCellContext(state.selection.$from);
    expect(ctx!.rowIndex).toBe(2);
    expect(ctx!.cellIndex).toBe(0);
  });

  test("先頭セルの Shift-Tab は何もしないが消費する（表の outdent を防ぐ）", () => {
    const doc = twoByTwo();
    const before = stateInCell(doc, 0);
    const { state, handled } = run(before, tablePrevCell);
    expect(handled).toBe(true);
    expect(state.doc).toBe(before.doc);
  });
});

describe("tableEnter", () => {
  test("Enter は同じ列の次の行へ", () => {
    const doc = twoByTwo();
    const { state } = run(stateInCell(doc, 1), tableEnter);
    expect(state.selection.$from.parent.textContent).toBe("d");
  });

  test("最終行の Enter は表を抜けて直後に空 paragraph", () => {
    const doc = twoByTwo();
    const { state } = run(stateInCell(doc, 2), tableEnter);
    const group = state.doc.child(0);
    expect(group.childCount).toBe(2);
    expect(group.child(1).child(0).type).toBe(nodes.paragraph);
    expect(state.selection.$from.parent.type).toBe(nodes.paragraph);
  });
});

describe("cell 内の防衛", () => {
  test("Shift-Enter はセル内に hardBreak を入れる", () => {
    const doc = twoByTwo();
    const { state } = run(stateInCell(doc, 0, 1), tableHardBreak);
    const cell = cellPositions(state.doc)[0];
    expect(state.doc.nodeAt(cell)!.childCount).toBe(2);
    expect(state.doc.nodeAt(cell)!.child(1).type).toBe(nodes.hardBreak);
  });

  test("splitBlock はセル内では発火しない（表を割らない）", () => {
    const doc = twoByTwo();
    const { handled } = run(stateInCell(doc, 0, 1), splitBlock);
    expect(handled).toBe(false);
  });
});

describe("blocksToPlainText", () => {
  test("table はセルを ` | `、行を改行で区切る", () => {
    const doc = twoByTwo();
    expect(blocksToPlainText([doc.child(0).child(0)])).toBe("a | b\nc | d");
  });
});

describe("exitDocEnd / exitDocStart", () => {
  test("最終行以外の Ctrl-n は表を抜けない（endOfTextblock がセル単位で真になる罠）", () => {
    const doc = twoByTwo();
    const { state, handled } = run(stateInCell(doc, 0), exitDocEnd);
    expect(handled).toBe(false);
    expect(state.doc).toBe(doc);
  });

  test("最終行の Ctrl-n は脱出ハッチとして空 paragraph を足す", () => {
    const doc = twoByTwo();
    const { state, handled } = run(stateInCell(doc, 2), exitDocEnd);
    expect(handled).toBe(true);
    expect(state.doc.child(0).childCount).toBe(2);
  });

  test("先頭行以外の Ctrl-p は表を抜けない", () => {
    const doc = twoByTwo();
    const { state, handled } = run(stateInCell(doc, 2), exitDocStart);
    expect(handled).toBe(false);
    expect(state.doc).toBe(doc);
  });
});
