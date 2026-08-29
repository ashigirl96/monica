import type { Fragment, Node as PMNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Command, EditorState, Transaction } from "@milkdown/kit/prose/state";
import { nodes } from "./schema";
import { insertParagraphAfter } from "./commands";

// table は blockContent で唯一、入れ子の textblock（tableCell）を持つ。既存 command 群は
// 「contentNode = カーソルの親 textblock」を前提にしているため、cell 内のキー操作は
// keymap の各 chain の先頭でここの command 群が先取りする（getBlockContext は table を
// 包む blockContainer を返すので、後続 command は cell 内では誤った単位で動く）。

export type TableCellContext = {
  containerPos: number;
  tablePos: number;
  tableNode: PMNode;
  rowIndex: number;
  cellIndex: number;
  cellPos: number;
  cellNode: PMNode;
};

/** カーソルを含む tableCell の文脈。table 外なら null。 */
export function getTableCellContext($pos: ResolvedPos): TableCellContext | null {
  for (let depth = $pos.depth; depth >= 5; depth--) {
    if ($pos.node(depth).type !== nodes.tableCell) continue;
    // cell(d) < tableRow(d-1) < table(d-2) < blockContainer(d-3) は schema が保証する
    return {
      cellNode: $pos.node(depth),
      cellPos: $pos.before(depth),
      cellIndex: $pos.index(depth - 1),
      rowIndex: $pos.index(depth - 2),
      tableNode: $pos.node(depth - 2),
      tablePos: $pos.before(depth - 2),
      containerPos: $pos.before(depth - 3),
    };
  }
  return null;
}

export function cellStartPos(
  tablePos: number,
  table: PMNode,
  rowIndex: number,
  cellIndex: number,
): number {
  let pos = tablePos + 1;
  for (let r = 0; r < rowIndex; r++) pos += table.child(r).nodeSize;
  pos += 1;
  const row = table.child(rowIndex);
  for (let c = 0; c < cellIndex; c++) pos += row.child(c).nodeSize;
  return pos;
}

function selectCellTr(
  state: EditorState,
  ctx: TableCellContext,
  rowIndex: number,
  cellIndex: number,
): Transaction {
  const row = ctx.tableNode.child(rowIndex);
  const col = Math.min(cellIndex, row.childCount - 1);
  const pos = cellStartPos(ctx.tablePos, ctx.tableNode, rowIndex, col);
  const cell = row.child(col);
  return state.tr.setSelection(TextSelection.create(state.doc, pos + 1 + cell.content.size));
}

/** Tab: 次のセルへ。最終セルでは空行を 1 行足して、その先頭セルへ。 */
export const tableNextCell: Command = (state, dispatch) => {
  const ctx = getTableCellContext(state.selection.$from);
  if (!ctx) return false;
  let rowIndex = ctx.rowIndex;
  let cellIndex = ctx.cellIndex + 1;
  if (cellIndex >= ctx.tableNode.child(rowIndex).childCount) {
    rowIndex += 1;
    cellIndex = 0;
  }
  if (rowIndex >= ctx.tableNode.childCount) {
    if (dispatch) {
      const width = ctx.tableNode.child(ctx.tableNode.childCount - 1).childCount;
      const cells = Array.from({ length: width }, () => nodes.tableCell.create());
      const at = ctx.tablePos + ctx.tableNode.nodeSize - 1;
      const tr = state.tr.insert(at, nodes.tableRow.create(null, cells));
      tr.setSelection(TextSelection.create(tr.doc, at + 2));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  dispatch?.(selectCellTr(state, ctx, rowIndex, cellIndex).scrollIntoView());
  return true;
};

/** Shift-Tab: 前のセルへ。先頭セルでは何もしない（表 container の outdent を防ぐ）。 */
export const tablePrevCell: Command = (state, dispatch) => {
  const ctx = getTableCellContext(state.selection.$from);
  if (!ctx) return false;
  let rowIndex = ctx.rowIndex;
  let cellIndex = ctx.cellIndex - 1;
  if (cellIndex < 0) {
    rowIndex -= 1;
    if (rowIndex < 0) return true;
    cellIndex = ctx.tableNode.child(rowIndex).childCount - 1;
  }
  dispatch?.(selectCellTr(state, ctx, rowIndex, cellIndex).scrollIntoView());
  return true;
};

/** Enter: 同じ列の次の行へ。最終行では表を抜けて直後に空 paragraph（脱出ハッチ）。 */
export const tableEnter: Command = (state, dispatch) => {
  const ctx = getTableCellContext(state.selection.$from);
  if (!ctx) return false;
  const nextRow = ctx.rowIndex + 1;
  if (nextRow >= ctx.tableNode.childCount) {
    const tr = insertParagraphAfter(state, ctx.containerPos);
    if (tr) dispatch?.(tr.scrollIntoView());
    return true;
  }
  dispatch?.(selectCellTr(state, ctx, nextRow, ctx.cellIndex).scrollIntoView());
  return true;
};

/** Mod-Enter: 行位置に関わらず表を抜けて直後に空 paragraph。 */
export const tableExit: Command = (state, dispatch) => {
  const ctx = getTableCellContext(state.selection.$from);
  if (!ctx) return false;
  const tr = insertParagraphAfter(state, ctx.containerPos);
  if (tr) dispatch?.(tr.scrollIntoView());
  return true;
};

/** Shift-Enter: セル内改行（insertHardBreak は isTextBlock ガードで table に効かない）。 */
export const tableHardBreak: Command = (state, dispatch) => {
  if (!getTableCellContext(state.selection.$from)) return false;
  dispatch?.(state.tr.replaceSelectionWith(nodes.hardBreak.create()).scrollIntoView());
  return true;
};

/** Ctrl-a: セル内の先頭へ（cursorToLineStart は table 内で非 textblock 位置に飛ぶ）。 */
export const tableLineStart: Command = (state, dispatch) => {
  const ctx = getTableCellContext(state.selection.$from);
  if (!ctx) return false;
  dispatch?.(
    state.tr.setSelection(TextSelection.create(state.doc, ctx.cellPos + 1)).scrollIntoView(),
  );
  return true;
};

/** Ctrl-e: セル内の末尾へ。 */
export const tableLineEnd: Command = (state, dispatch) => {
  const ctx = getTableCellContext(state.selection.$from);
  if (!ctx) return false;
  const target = ctx.cellPos + 1 + ctx.cellNode.content.size;
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView());
  return true;
};

/** slash menu 用: header 行 + 空 2 行の 2 列表。seed は元 block の inline を先頭セルへ引き継ぐ。 */
export function createTableContent(seed?: Fragment): PMNode {
  const headerCell = (content?: Fragment) =>
    nodes.tableCell.create({ header: true }, content && content.size > 0 ? content : undefined);
  const cell = () => nodes.tableCell.create();
  return nodes.table.create(null, [
    nodes.tableRow.create(null, [headerCell(seed), headerCell()]),
    nodes.tableRow.create(null, [cell(), cell()]),
    nodes.tableRow.create(null, [cell(), cell()]),
  ]);
}
