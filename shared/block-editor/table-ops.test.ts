/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Command } from "@milkdown/kit/prose/state";
import { nodes } from "./schema";
import { getTableCellContext } from "./table";
import {
  tableDeleteColumn,
  tableDeleteRow,
  tableInsertColumnLeft,
  tableInsertColumnRight,
  tableInsertRowAbove,
  tableInsertRowBelow,
} from "./table-ops";
import { blocksToPlainText } from "./clipboard";
import { block, contentPos, docOf, para, run, stateInCell, tableOf } from "./test-fixtures";

const twoByTwo = (header = false) =>
  docOf(
    block(
      "T",
      tableOf(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        header,
      ),
    ),
  );

const ragged = () => docOf(block("T", tableOf([["a", "b", "c"], ["d"]])));

function tableOf_(doc: PMNode): PMNode {
  return doc.child(0).child(0).child(0);
}

function rowTexts(table: PMNode, r: number): string[] {
  const row = table.child(r);
  return Array.from({ length: row.childCount }, (_, c) => row.child(c).textContent);
}

function rowHeaders(table: PMNode, r: number): boolean[] {
  const row = table.child(r);
  return Array.from({ length: row.childCount }, (_, c) => row.child(c).attrs.header as boolean);
}

function apply(doc: PMNode, cellIndex: number, command: Command) {
  const { state, handled } = run(stateInCell(doc, cellIndex), command);
  expect(handled).toBe(true);
  state.doc.check();
  const ctx = getTableCellContext(state.selection.$from);
  return { state, table: tableOf_(state.doc), ctx };
}

describe("行の挿入", () => {
  test("上に挿入: 現在行の位置に幅の揃った空行が入り、カーソルは新行の同じ列", () => {
    const { table, ctx } = apply(twoByTwo(), 3, tableInsertRowAbove);
    expect(table.childCount).toBe(3);
    expect(rowTexts(table, 1)).toEqual(["", ""]);
    expect(rowTexts(table, 2)).toEqual(["c", "d"]);
    expect(ctx).toMatchObject({ rowIndex: 1, cellIndex: 1 });
  });

  test("header 行の上に挿入: 新行が header になり旧 header は降格する（delimiter は 1 行目直後のまま）", () => {
    const { state, table } = apply(twoByTwo(true), 0, tableInsertRowAbove);
    expect(rowHeaders(table, 0)).toEqual([true, true]);
    expect(rowHeaders(table, 1)).toEqual([false, false]);
    expect(blocksToPlainText([state.doc.child(0).child(0)])).toBe(
      "|  |  |\n| --- | --- |\n| a | b |\n| c | d |",
    );
  });

  test("下に挿入（最終行）: 末尾に追加されカーソルは新行", () => {
    const { table, ctx } = apply(twoByTwo(), 2, tableInsertRowBelow);
    expect(table.childCount).toBe(3);
    expect(rowTexts(table, 2)).toEqual(["", ""]);
    expect(ctx).toMatchObject({ rowIndex: 2, cellIndex: 0 });
  });

  test("header 表の下に挿入した行は header にならない", () => {
    const { table } = apply(twoByTwo(true), 0, tableInsertRowBelow);
    expect(rowHeaders(table, 1)).toEqual([false, false]);
  });
});

describe("列の挿入", () => {
  test("左に挿入: 全行に空セルが入り、header は同じ行の隣から写す", () => {
    const { table, ctx } = apply(twoByTwo(true), 0, tableInsertColumnLeft);
    expect(rowTexts(table, 0)).toEqual(["", "a", "b"]);
    expect(rowTexts(table, 1)).toEqual(["", "c", "d"]);
    expect(rowHeaders(table, 0)).toEqual([true, true, true]);
    expect(rowHeaders(table, 1)).toEqual([false, false, false]);
    expect(ctx).toMatchObject({ rowIndex: 0, cellIndex: 0 });
    expect(ctx!.cellNode.textContent).toBe("");
  });

  test("右に挿入（最終列）: 末尾に追加されカーソルは新列", () => {
    const { table, ctx } = apply(twoByTwo(), 3, tableInsertColumnRight);
    expect(rowTexts(table, 0)).toEqual(["a", "b", ""]);
    expect(rowTexts(table, 1)).toEqual(["c", "d", ""]);
    expect(ctx).toMatchObject({ rowIndex: 1, cellIndex: 2 });
  });

  test("ragged: 幅の足りない行には末尾に付ける", () => {
    const { table } = apply(ragged(), 2, tableInsertColumnRight);
    expect(rowTexts(table, 0)).toEqual(["a", "b", "c", ""]);
    expect(rowTexts(table, 1)).toEqual(["d", ""]);
  });
});

describe("行の削除", () => {
  test("中間行を消すとカーソルは繰り上がった行の同じ列", () => {
    const doc = docOf(block("T", tableOf([["a"], ["b"], ["c"]])));
    const { table, ctx } = apply(doc, 1, tableDeleteRow);
    expect(table.childCount).toBe(2);
    expect(rowTexts(table, 1)).toEqual(["c"]);
    expect(ctx).toMatchObject({ rowIndex: 1, cellIndex: 0 });
    expect(ctx!.cellNode.textContent).toBe("c");
  });

  test("最終行を消すとカーソルは新しい最終行", () => {
    const { table, ctx } = apply(twoByTwo(), 3, tableDeleteRow);
    expect(table.childCount).toBe(1);
    expect(ctx).toMatchObject({ rowIndex: 0, cellIndex: 1 });
  });

  test("1 行だけの表は空 paragraph になる（container id は維持）", () => {
    const doc = docOf(block("T", tableOf([["a", "b"]])));
    const { state } = run(stateInCell(doc, 0), tableDeleteRow);
    state.doc.check();
    const container = state.doc.child(0).child(0);
    expect(container.attrs.id).toBe("T");
    expect(container.child(0).type).toBe(nodes.paragraph);
    expect(container.child(0).content.size).toBe(0);
    expect(state.selection.$from.parent.type).toBe(nodes.paragraph);
  });
});

describe("列の削除", () => {
  test("全行から同じ列が消え、残りの header は維持される", () => {
    const { table, ctx } = apply(twoByTwo(true), 0, tableDeleteColumn);
    expect(rowTexts(table, 0)).toEqual(["b"]);
    expect(rowTexts(table, 1)).toEqual(["d"]);
    expect(rowHeaders(table, 0)).toEqual([true]);
    expect(ctx).toMatchObject({ rowIndex: 0, cellIndex: 0 });
  });

  test("最終列を消すとカーソルは新しい最終列", () => {
    const { ctx } = apply(twoByTwo(), 1, tableDeleteColumn);
    expect(ctx).toMatchObject({ rowIndex: 0, cellIndex: 0 });
    expect(ctx!.cellNode.textContent).toBe("a");
  });

  test("ragged: 幅の足りない行は触らない", () => {
    const { table } = apply(ragged(), 2, tableDeleteColumn);
    expect(rowTexts(table, 0)).toEqual(["a", "b"]);
    expect(rowTexts(table, 1)).toEqual(["d"]);
  });

  test("ragged: 幅 1 の行から消しても、広い行のセルは失われない", () => {
    const { table } = apply(ragged(), 3, tableDeleteColumn);
    expect(rowTexts(table, 0)).toEqual(["b", "c"]);
    expect(rowTexts(table, 1)).toEqual(["d"]);
  });

  test("幅 1 の表は空 paragraph になる", () => {
    const doc = docOf(block("T", tableOf([["a"], ["b"]])));
    const { state } = run(stateInCell(doc, 0), tableDeleteColumn);
    state.doc.check();
    const container = state.doc.child(0).child(0);
    expect(container.attrs.id).toBe("T");
    expect(container.child(0).type).toBe(nodes.paragraph);
  });
});

describe("表の外", () => {
  test.each([
    ["tableInsertRowAbove", tableInsertRowAbove],
    ["tableInsertRowBelow", tableInsertRowBelow],
    ["tableInsertColumnLeft", tableInsertColumnLeft],
    ["tableInsertColumnRight", tableInsertColumnRight],
    ["tableDeleteRow", tableDeleteRow],
    ["tableDeleteColumn", tableDeleteColumn],
  ])("%s は false を返して何もしない", (_name, command) => {
    const doc = docOf(block("P", para("x")));
    const outside = EditorState.create({
      doc,
      selection: TextSelection.create(doc, contentPos(doc, "P", "end")),
    });
    const { state: next, handled } = run(outside, command);
    expect(handled).toBe(false);
    expect(next.doc).toBe(doc);
  });
});
