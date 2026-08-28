import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Command, EditorState, Transaction } from "@milkdown/kit/prose/state";
import { nodes } from "./schema";
import { cellStartPos, getTableCellContext } from "./table";
import type { TableCellContext } from "./table";

// 表の構造編集（行・列の挿入 / 削除）。normalizer は表を見ないので、行幅の矩形性は
// ここで自分で保つ。header はセル単位の attr だが、markdown 側（tableToGfm / Rust
// render_table）は「header セルは row 0 にだけ居る」前提で delimiter を出すため、
// 行・列を足すときはその不変条件を崩さないよう header を写す / 移す。

/** row の before position。rowIndex === childCount なら表の末尾（tableNextCell と同じ位置） */
function rowStartPos(tablePos: number, table: PMNode, rowIndex: number): number {
  let pos = tablePos + 1;
  for (let r = 0; r < rowIndex; r++) pos += table.child(r).nodeSize;
  return pos;
}

function rowIsHeader(row: PMNode): boolean {
  for (let i = 0; i < row.childCount; i++) if (row.child(i).attrs.header) return true;
  return false;
}

function emptyRow(width: number, header: boolean): PMNode {
  return nodes.tableRow.create(
    null,
    Array.from({ length: width }, () => nodes.tableCell.create({ header })),
  );
}

/** 編集後の tr.doc で表を再解決し、index を新しい範囲に clamp してセル先頭へ */
function selectCellIn(tr: Transaction, tablePos: number, rowIndex: number, cellIndex: number) {
  const table = tr.doc.nodeAt(tablePos);
  if (!table) return;
  const r = Math.min(rowIndex, table.childCount - 1);
  const c = Math.min(cellIndex, table.child(r).childCount - 1);
  tr.setSelection(TextSelection.create(tr.doc, cellStartPos(tablePos, table, r, c) + 1));
}

function tableWidth(table: PMNode): number {
  let max = 0;
  for (let r = 0; r < table.childCount; r++) max = Math.max(max, table.child(r).childCount);
  return max;
}

/** 最後の行 / 列を消すときは表ごと空 paragraph に置き換える（container と id は残す） */
function tableToParagraph(tr: Transaction, ctx: TableCellContext): void {
  tr.replaceWith(ctx.tablePos, ctx.tablePos + ctx.tableNode.nodeSize, nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, ctx.tablePos + 1));
}

export function insertRowTr(
  state: EditorState,
  ctx: TableCellContext,
  side: "above" | "below",
): Transaction {
  const index = side === "above" ? ctx.rowIndex : ctx.rowIndex + 1;
  const width = ctx.tableNode.child(ctx.rowIndex).childCount;
  const tr = state.tr;
  const takesHeader = index === 0 && rowIsHeader(ctx.tableNode.child(0));
  if (takesHeader) {
    const row0 = ctx.tableNode.child(0);
    for (let c = 0; c < row0.childCount; c++) {
      const pos = cellStartPos(ctx.tablePos, ctx.tableNode, 0, c);
      tr.setNodeMarkup(pos, undefined, { header: false });
    }
  }
  const at = rowStartPos(ctx.tablePos, ctx.tableNode, index);
  tr.insert(at, emptyRow(width, takesHeader));
  selectCellIn(tr, ctx.tablePos, index, ctx.cellIndex);
  return tr;
}

export function deleteRowTr(state: EditorState, ctx: TableCellContext): Transaction {
  const tr = state.tr;
  if (ctx.tableNode.childCount === 1) {
    tableToParagraph(tr, ctx);
    return tr;
  }
  // header 行を消すときは後続行へ header を移す。setNodeMarkup は node size を
  // 変えないので、この後の delete も元 doc の位置のまま使える
  if (ctx.rowIndex === 0 && rowIsHeader(ctx.tableNode.child(0))) {
    const successor = ctx.tableNode.child(1);
    for (let c = 0; c < successor.childCount; c++) {
      const pos = cellStartPos(ctx.tablePos, ctx.tableNode, 1, c);
      tr.setNodeMarkup(pos, undefined, { header: true });
    }
  }
  const from = rowStartPos(ctx.tablePos, ctx.tableNode, ctx.rowIndex);
  tr.delete(from, from + ctx.tableNode.child(ctx.rowIndex).nodeSize);
  selectCellIn(tr, ctx.tablePos, ctx.rowIndex, ctx.cellIndex);
  return tr;
}

export function insertColumnTr(
  state: EditorState,
  ctx: TableCellContext,
  side: "left" | "right",
): Transaction {
  const col = side === "left" ? ctx.cellIndex : ctx.cellIndex + 1;
  const tr = state.tr;
  // 末尾行から遡ると各挿入位置は直前の挿入より必ず手前なので、元 doc の位置がそのまま使える
  for (let r = ctx.tableNode.childCount - 1; r >= 0; r--) {
    const row = ctx.tableNode.child(r);
    const c = Math.min(col, row.childCount);
    const neighbor = row.child(Math.min(c, row.childCount - 1));
    const at =
      c === row.childCount
        ? rowStartPos(ctx.tablePos, ctx.tableNode, r) + row.nodeSize - 1
        : cellStartPos(ctx.tablePos, ctx.tableNode, r, c);
    tr.insert(at, nodes.tableCell.create({ header: neighbor.attrs.header }));
  }
  selectCellIn(tr, ctx.tablePos, ctx.rowIndex, col);
  return tr;
}

export function deleteColumnTr(state: EditorState, ctx: TableCellContext): Transaction {
  const col = ctx.cellIndex;
  const tr = state.tr;
  // 選択行だけでなく全行が幅 1 のときにだけ畳む。ragged な表で幅 1 の行から消すと
  // 表ごと落ちて、より広い行のセルが道連れになる
  if (tableWidth(ctx.tableNode) === 1) {
    tableToParagraph(tr, ctx);
    return tr;
  }
  for (let r = ctx.tableNode.childCount - 1; r >= 0; r--) {
    const row = ctx.tableNode.child(r);
    // tableRow は tableCell+ なので空行にはできない。幅の足りない行は触らない
    if (col >= row.childCount || row.childCount === 1) continue;
    const at = cellStartPos(ctx.tablePos, ctx.tableNode, r, col);
    tr.delete(at, at + row.child(col).nodeSize);
  }
  selectCellIn(tr, ctx.tablePos, ctx.rowIndex, col);
  return tr;
}

function tableCommand(build: (state: EditorState, ctx: TableCellContext) => Transaction): Command {
  return (state, dispatch) => {
    const ctx = getTableCellContext(state.selection.$from);
    if (!ctx) return false;
    dispatch?.(build(state, ctx).setMeta("blockOperation", { type: "table" }).scrollIntoView());
    return true;
  };
}

export const tableInsertRowAbove = tableCommand((s, ctx) => insertRowTr(s, ctx, "above"));
export const tableInsertRowBelow = tableCommand((s, ctx) => insertRowTr(s, ctx, "below"));
export const tableInsertColumnLeft = tableCommand((s, ctx) => insertColumnTr(s, ctx, "left"));
export const tableInsertColumnRight = tableCommand((s, ctx) => insertColumnTr(s, ctx, "right"));
export const tableDeleteRow = tableCommand(deleteRowTr);
export const tableDeleteColumn = tableCommand(deleteColumnTr);
