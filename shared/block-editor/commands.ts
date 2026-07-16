import type { Node as PMNode, NodeType, Attrs, ResolvedPos } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Command, EditorState, Transaction } from "@milkdown/kit/prose/state";
import {
  createContainer,
  emptyParagraphContainer,
  isListLike,
  isTextBlock,
  nodes,
  reissueIds,
  schema,
} from "./schema";
import {
  childStartPos,
  containerById,
  getBlockContext,
  rangeFromContext,
  rangePositions,
  type BlockContext,
  type SiblingRange,
} from "./context";
import { clearBlockSelection, selectBlocks } from "./selection-state";

function containerChildren(container: PMNode): readonly PMNode[] {
  return container.childCount > 1 ? container.child(1).content.content : [];
}

function withChildren(container: PMNode, content: PMNode, children: readonly PMNode[]): PMNode {
  return nodes.blockContainer.create(
    container.attrs,
    children.length > 0 ? [content, nodes.blockGroup.create(null, [...children])] : [content],
  );
}

// カーソルを ID + container 内 offset で復元する（TODO.md §1.4）。
function restoreCursor(tr: Transaction, id: string, offset: number): void {
  const entry = containerById(tr.doc, id);
  if (!entry) return;
  const pos = Math.min(entry.pos + offset, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
}

// ---- indent / outdent（TODO.md §3） ----

export function indentRange(state: EditorState, range: SiblingRange): Transaction | null {
  if (range.fromIndex === 0) return null;
  const group = range.groupNode;
  const prev = group.child(range.fromIndex - 1);
  if (prev.child(0).type === nodes.divider) return null;
  const selected: PMNode[] = [];
  for (let i = range.fromIndex; i <= range.toIndex; i++) selected.push(group.child(i));
  const newPrev = withChildren(prev, prev.child(0), [...containerChildren(prev), ...selected]);
  const start = childStartPos(range.groupPos, group, range.fromIndex - 1);
  const { end } = rangePositions(range);
  return state.tr.replaceWith(start, end, newPrev).setMeta("blockOperation", { type: "indent" });
}

export function outdentRange(state: EditorState, range: SiblingRange): Transaction | null {
  if (range.parentContainerPos === null) return null;
  const parentPos = range.parentContainerPos;
  const parent = state.doc.nodeAt(parentPos);
  if (!parent) return null;
  const group = range.groupNode;
  const preceding: PMNode[] = [];
  const selected: PMNode[] = [];
  const following: PMNode[] = [];
  group.forEach((child, _offset, i) => {
    if (i < range.fromIndex) preceding.push(child);
    else if (i <= range.toIndex) selected.push(child);
    else following.push(child);
  });
  // §3.2: 見た目の pre-order を保つため、後続兄弟は最後に lift した block の子へ
  if (following.length > 0) {
    const last = selected[selected.length - 1];
    selected[selected.length - 1] = withChildren(last, last.child(0), [
      ...containerChildren(last),
      ...following,
    ]);
  }
  const newParent = withChildren(parent, parent.child(0), preceding);
  return state.tr
    .replaceWith(parentPos, parentPos + parent.nodeSize, [newParent, ...selected])
    .setMeta("blockOperation", { type: "outdent" });
}

function structureCommand(
  build: (state: EditorState, range: SiblingRange) => Transaction | null,
): Command {
  return (state, dispatch) => {
    const ctx = getBlockContext(state.selection.$from);
    if (!ctx) return false;
    const cursorId = ctx.containerNode.attrs.id as string | null;
    const offset = state.selection.head - ctx.containerPos;
    const tr = build(state, rangeFromContext(ctx));
    if (tr && dispatch) {
      if (cursorId) restoreCursor(tr, cursorId, offset);
      dispatch(tr.scrollIntoView());
    }
    // 変更できない場合も true: Tab によるブラウザ focus 移動を起こさない（KEY-003）
    return true;
  };
}

export const indentBlock: Command = structureCommand(indentRange);
export const outdentBlock: Command = structureCommand(outdentRange);

// ---- 型変換（TODO.md §1.2: ID と children を維持） ----

function inlineToPlainText(content: PMNode): PMNode | undefined {
  const text = content.content.textBetween(0, content.content.size, undefined, "\n");
  return text.length > 0 ? schema.text(text) : undefined;
}

export function setContentType(
  state: EditorState,
  ctx: BlockContext,
  type: NodeType,
  attrs: Attrs | null,
): Transaction {
  const content = ctx.contentNode;
  let newContent: PMNode;
  if (type === nodes.divider) newContent = type.create();
  else if (type === nodes.codeBlock) newContent = type.create(attrs, inlineToPlainText(content));
  else if (content.type === nodes.codeBlock || content.type === nodes.divider)
    newContent = type.create(attrs, content.type === nodes.divider ? undefined : content.content);
  else newContent = type.create(attrs, content.content);
  const tr = state.tr
    .replaceWith(ctx.contentPos, ctx.contentPos + content.nodeSize, newContent)
    .setMeta("blockOperation", { type: "setBlockType" });
  // replaceWith は範囲内 position を潰す（カーソルが後続 block へ飛ぶ）ので、
  // content 内にいたカーソルは同じ offset へ張り直す
  const head = state.selection.head;
  if (
    newContent.inlineContent &&
    head >= ctx.contentPos &&
    head <= ctx.contentPos + content.nodeSize
  ) {
    const offset = Math.min(Math.max(head - (ctx.contentPos + 1), 0), newContent.content.size);
    tr.setSelection(TextSelection.create(tr.doc, ctx.contentPos + 1 + offset));
  }
  return tr;
}

// ---- split（TODO.md §4） ----

function splitRightContent(content: PMNode, offset: number): PMNode {
  const atEnd = offset === content.content.size;
  const right = content.cut(offset).content;
  const t = content.type;
  if (t === nodes.heading) return atEnd ? nodes.paragraph.create() : t.create(content.attrs, right);
  if (t === nodes.todo) return t.create({ checked: false }, right);
  if (t === nodes.quote || t === nodes.callout)
    return atEnd ? nodes.paragraph.create() : t.create(null, right);
  // toggle 末尾 Enter は「同型の新 toggle」に固定（TODO.md §4.1 の product 設定）
  if (t === nodes.toggle) return t.create({ open: true }, right);
  return t.create(content.attrs, right);
}

// WebKit の IME 確定 (deleteCompositionText) は、composition が block の全内容の
// とき block DOM ごと除去して <br> に置き換える（prosemirror-view 1.41.5 の
// table-cell kludge と同族の Safari regression の div 版。upstream 未修正）。
// prosemirror-view はこの DOM 差分を Enter と誤認して synthetic keydown を投げ、
// さらに flush 後に DOM を state から復元するため、放置すると直後の
// insertFromComposition が確定文字を二重挿入する。Enter を消費しつつ、WebKit が
// 行った削除を doc へ反映して doc / DOM / WebKit の三者の認識を揃える。
// 本物の確定 Enter は keyCode 229 と compositionEndedAt のガードで keymap に届かない。
export const ignoreCompositionEnter: Command = (state, dispatch, view) => {
  if (view?.composing !== true) return false;
  const ctx = getBlockContext(state.selection.$from);
  if (ctx && dispatch && ctx.contentNode.content.size > 0) {
    const dom = view.nodeDOM(ctx.contentPos);
    const domEmptied =
      !(dom instanceof HTMLElement) || !dom.isConnected || !/\S/.test(dom.textContent ?? "");
    if (domEmptied) {
      dispatch(
        state.tr.delete(ctx.contentPos + 1, ctx.contentPos + 1 + ctx.contentNode.content.size),
      );
    }
  }
  return true;
};

export const splitBlock: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return false;
  const preCtx = getBlockContext(sel.$from);
  if (!preCtx) return false;
  if (preCtx.contentNode.type === nodes.codeBlock || preCtx.contentNode.type === nodes.divider)
    return false;

  // §4.2: 空 list-like は Enter で outdent（nested）/ paragraph 化（root）
  if (sel.empty && isListLike(preCtx.contentNode.type) && preCtx.contentNode.content.size === 0) {
    const cursorId = preCtx.containerNode.attrs.id as string | null;
    if (preCtx.parentContainerPos !== null) {
      const tr = outdentRange(state, rangeFromContext(preCtx));
      if (tr && dispatch) {
        if (cursorId) restoreCursor(tr, cursorId, 2);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    dispatch?.(setContentType(state, preCtx, nodes.paragraph, null).scrollIntoView());
    return true;
  }

  const tr = state.tr;
  if (!sel.empty) tr.deleteSelection();
  const $from = tr.selection.$from;
  const ctx = getBlockContext($from);
  if (!ctx) return false;
  const content = ctx.contentNode;
  const offset = $from.pos - (ctx.contentPos + 1);
  // callout 行の Enter は兄弟に割らず、内部（先頭の子）に新しい行を作る。
  // カーソル以降のテキストはその子 paragraph へ移す。
  if (content.type === nodes.callout) {
    const leftContent = content.cut(0, offset);
    const child = createContainer(nodes.paragraph.create(null, content.cut(offset).content));
    const newContainer = withChildren(ctx.containerNode, leftContent, [
      child,
      ...containerChildren(ctx.containerNode),
    ]);
    tr.replaceWith(ctx.containerPos, ctx.containerPos + ctx.containerNode.nodeSize, newContainer);
    tr.setSelection(TextSelection.create(tr.doc, ctx.containerPos + leftContent.nodeSize + 4));
    tr.setMeta("blockOperation", { type: "split" });
    dispatch?.(tr.scrollIntoView());
    return true;
  }
  // 左 block が元 ID・children を保持し、右 block は新 ID で subtree の直後に入る
  const left = content.cut(0, offset);
  const leftContainer = withChildren(ctx.containerNode, left, containerChildren(ctx.containerNode));
  const rightContainer = createContainer(splitRightContent(content, offset));
  tr.replaceWith(ctx.containerPos, ctx.containerPos + ctx.containerNode.nodeSize, [
    leftContainer,
    rightContainer,
  ]);
  tr.setSelection(TextSelection.create(tr.doc, ctx.containerPos + leftContainer.nodeSize + 2));
  tr.setMeta("blockOperation", { type: "split" });
  dispatch?.(tr.scrollIntoView());
  return true;
};

export const insertHardBreak: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx || !isTextBlock(ctx.contentNode.type)) return false;
  dispatch?.(state.tr.replaceSelectionWith(nodes.hardBreak.create()).scrollIntoView());
  return true;
};

// カーソルを含む最も内側の callout container を祖先から探す。
function calloutAncestor($pos: ResolvedPos): { pos: number; node: PMNode } | null {
  for (let depth = $pos.depth; depth >= 2; depth--) {
    const node = $pos.node(depth);
    if (node.type === nodes.blockContainer && node.child(0).type === nodes.callout) {
      return { pos: $pos.before(depth), node };
    }
  }
  return null;
}

// callout 内での Shift-Enter: callout を抜けて直後に空 paragraph を足す。
export const exitCallout: Command = (state, dispatch) => {
  const found = calloutAncestor(state.selection.$from);
  if (!found) return false;
  const at = found.pos + found.node.nodeSize;
  const tr = state.tr.insert(at, emptyParagraphContainer());
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  tr.setMeta("blockOperation", { type: "insert" });
  dispatch?.(tr.scrollIntoView());
  return true;
};

// ---- merge（TODO.md §5） ----

function selectSingleBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  id: string,
): boolean {
  if (dispatch) dispatch(selectBlocks(state.tr, id, id));
  return true;
}

function mergeInto(
  state: EditorState,
  targetPos: number,
  target: PMNode,
  source: PMNode,
  sourceEnd: number,
): Transaction {
  // source の inline を target の content 末尾へ、source の children を target の children 末尾へ
  const targetContent = target.child(0);
  const merged = targetContent.type.create(
    targetContent.attrs,
    targetContent.content.append(source.child(0).content),
  );
  const children = [...containerChildren(target), ...containerChildren(source)];
  const newTarget = withChildren(target, merged, children);
  const tr = state.tr.replaceWith(targetPos, sourceEnd, newTarget);
  tr.setSelection(TextSelection.create(tr.doc, targetPos + 2 + targetContent.content.size));
  return tr.setMeta("blockOperation", { type: "merge" });
}

export const backspaceBlock: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return false;
  const ctx = getBlockContext(sel.$from);
  if (!ctx) return false;
  if (sel.$from.parentOffset > 0) return false;
  const content = ctx.contentNode;
  if (sel.$from.parent !== content) return false;
  const isEmpty = content.content.size === 0;
  const nested = ctx.parentContainerPos !== null;

  // 特殊型は先頭 Backspace でまず paragraph へ戻す（Notion 実機挙動。nest は維持）
  if (content.type !== nodes.paragraph && content.type !== nodes.codeBlock) {
    dispatch?.(setContentType(state, ctx, nodes.paragraph, null).scrollIntoView());
    return true;
  }
  if (content.type === nodes.codeBlock) {
    if (!isEmpty) return false;
    dispatch?.(setContentType(state, ctx, nodes.paragraph, null).scrollIntoView());
    return true;
  }

  const group = ctx.groupNode;
  const index = ctx.siblingIndex;
  if (index > 0) {
    const prev = group.child(index - 1);
    const prevContent = prev.child(0);
    const prevId = prev.attrs.id as string | null;
    // 空 paragraph（子なし）は削除して前の可視 block 末尾へ
    if (isEmpty && ctx.containerNode.childCount === 1) {
      const tr = state.tr.delete(ctx.containerPos, ctx.containerPos + ctx.containerNode.nodeSize);
      tr.setSelection(TextSelection.near(tr.doc.resolve(ctx.containerPos), -1));
      dispatch?.(tr.scrollIntoView());
      return true;
    }
    // §5.1/§5.2: atom・code・子持ちへの merge は順序が壊れるので block-select に移行
    if (
      prevContent.type === nodes.divider ||
      prevContent.type === nodes.codeBlock ||
      prev.childCount > 1 ||
      !isTextBlock(prevContent.type)
    ) {
      return prevId ? selectSingleBlock(state, dispatch, prevId) : true;
    }
    const prevStart = childStartPos(ctx.groupPos, group, index - 1);
    const tr = mergeInto(
      state,
      prevStart,
      prev,
      ctx.containerNode,
      ctx.containerPos + ctx.containerNode.nodeSize,
    );
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  // group 先頭 child: 親へ merge（cur は先頭 child なので視覚順序を保てる）
  if (nested && ctx.parentContainerPos !== null) {
    const parentPos = ctx.parentContainerPos;
    const parent = state.doc.nodeAt(parentPos);
    if (!parent) return false;
    const parentContent = parent.child(0);
    const parentId = parent.attrs.id as string | null;
    if (!isTextBlock(parentContent.type)) {
      return parentId ? selectSingleBlock(state, dispatch, parentId) : true;
    }
    const merged = parentContent.type.create(
      parentContent.attrs,
      parentContent.content.append(content.content),
    );
    const rest: PMNode[] = [...containerChildren(ctx.containerNode)];
    group.forEach((child, _offset, i) => {
      if (i > 0) rest.push(child);
    });
    const newParent = withChildren(parent, merged, rest);
    const tr = state.tr.replaceWith(parentPos, parentPos + parent.nodeSize, newParent);
    tr.setSelection(TextSelection.create(tr.doc, parentPos + 2 + parentContent.content.size));
    tr.setMeta("blockOperation", { type: "merge" });
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  // root 先頭 block: 何もしないが Backspace は消費する（§5.1-6）
  return true;
};

export const deleteForwardBlock: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return false;
  const ctx = getBlockContext(sel.$from);
  if (!ctx) return false;
  const content = ctx.contentNode;
  if (sel.$from.parent !== content) return false;
  if (sel.$from.parentOffset < content.content.size) return false;

  // 子を持つなら次の可視 block は先頭 child: それを親へ merge
  if (ctx.containerNode.childCount > 1) {
    const childGroup = ctx.containerNode.child(1);
    const first = childGroup.child(0);
    const firstContent = first.child(0);
    const firstId = first.attrs.id as string | null;
    if (!isTextBlock(firstContent.type)) {
      return firstId ? selectSingleBlock(state, dispatch, firstId) : true;
    }
    const merged = content.type.create(content.attrs, content.content.append(firstContent.content));
    const rest: PMNode[] = [...containerChildren(first)];
    childGroup.forEach((child, _offset, i) => {
      if (i > 0) rest.push(child);
    });
    const newContainer = withChildren(ctx.containerNode, merged, rest);
    const tr = state.tr.replaceWith(
      ctx.containerPos,
      ctx.containerPos + ctx.containerNode.nodeSize,
      newContainer,
    );
    tr.setSelection(TextSelection.create(tr.doc, ctx.containerPos + 2 + content.content.size));
    tr.setMeta("blockOperation", { type: "merge" });
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  const group = ctx.groupNode;
  const index = ctx.siblingIndex;
  if (index >= group.childCount - 1) return true;
  const next = group.child(index + 1);
  const nextContent = next.child(0);
  const nextId = next.attrs.id as string | null;
  if (
    nextContent.type === nodes.divider ||
    nextContent.type === nodes.codeBlock ||
    !isTextBlock(nextContent.type)
  ) {
    return nextId ? selectSingleBlock(state, dispatch, nextId) : true;
  }
  const nextEnd = ctx.containerPos + ctx.containerNode.nodeSize + next.nodeSize;
  const tr = mergeInto(state, ctx.containerPos, ctx.containerNode, next, nextEnd);
  dispatch?.(tr.scrollIntoView());
  return true;
};

// ---- block selection 由来の一括操作（TODO.md §7.2） ----

export function deleteRange(state: EditorState, range: SiblingRange): Transaction {
  const group = range.groupNode;
  const { start, end } = rangePositions(range);
  const wholeGroup = range.fromIndex === 0 && range.toIndex === group.childCount - 1;
  const tr = state.tr;
  if (wholeGroup && range.parentContainerPos === null) {
    tr.replaceWith(
      range.groupPos + 1,
      range.groupPos + 1 + group.content.size,
      emptyParagraphContainer(),
    );
  } else if (wholeGroup) {
    // 空の blockGroup を残さない（TODO.md §1.5）
    tr.delete(range.groupPos, range.groupPos + group.nodeSize);
  } else {
    tr.delete(start, end);
  }
  const at = Math.min(start, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at), -1));
  clearBlockSelection(tr);
  return tr.setMeta("blockOperation", { type: "delete" });
}

export function duplicateRange(state: EditorState, range: SiblingRange): Transaction {
  const copies: PMNode[] = [];
  for (let i = range.fromIndex; i <= range.toIndex; i++)
    copies.push(reissueIds(range.groupNode.child(i)));
  const { end } = rangePositions(range);
  const tr = state.tr.insert(end, copies);
  selectBlocks(tr, copies[0].attrs.id as string, copies[copies.length - 1].attrs.id as string);
  return tr.setMeta("blockOperation", { type: "duplicate" });
}

export function moveRange(
  state: EditorState,
  range: SiblingRange,
  direction: "up" | "down",
): Transaction | null {
  const group = range.groupNode;
  const selected: PMNode[] = [];
  for (let i = range.fromIndex; i <= range.toIndex; i++) selected.push(group.child(i));
  if (direction === "up") {
    if (range.fromIndex === 0) return null;
    const prev = group.child(range.fromIndex - 1);
    const start = childStartPos(range.groupPos, group, range.fromIndex - 1);
    const { end } = rangePositions(range);
    return state.tr
      .replaceWith(start, end, [...selected, prev])
      .setMeta("blockOperation", { type: "move" });
  }
  if (range.toIndex >= group.childCount - 1) return null;
  const next = group.child(range.toIndex + 1);
  const { start, end } = rangePositions(range);
  return state.tr
    .replaceWith(start, end + next.nodeSize, [next, ...selected])
    .setMeta("blockOperation", { type: "move" });
}

// ---- 挿入・code block 内キー ----

export function insertParagraphAfter(state: EditorState, containerPos: number): Transaction | null {
  const container = state.doc.nodeAt(containerPos);
  if (!container || container.type !== nodes.blockContainer) return null;
  const inserted = emptyParagraphContainer();
  const at = containerPos + container.nodeSize;
  const tr = state.tr.insert(at, inserted);
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  clearBlockSelection(tr);
  return tr.setMeta("blockOperation", { type: "insert" });
}

export const exitCodeBlock: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx || ctx.contentNode.type !== nodes.codeBlock) return false;
  const tr = insertParagraphAfter(state, ctx.containerPos);
  if (tr) dispatch?.(tr.scrollIntoView());
  return true;
};

export const codeNewline: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx || ctx.contentNode.type !== nodes.codeBlock) return false;
  dispatch?.(state.tr.insertText("\n").scrollIntoView());
  return true;
};

// Ctrl-a / Ctrl-e（macOS 流の行頭・行末移動）。code block は現在行、text block は content 端。
export const cursorToLineStart: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx) return false;
  const content = ctx.contentNode;
  if (content.type === nodes.divider) return false;
  let target = ctx.contentPos + 1;
  if (content.type === nodes.codeBlock) {
    const offset = state.selection.head - (ctx.contentPos + 1);
    target = ctx.contentPos + 1 + content.textContent.lastIndexOf("\n", offset - 1) + 1;
  }
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView());
  return true;
};

export const cursorToLineEnd: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx) return false;
  const content = ctx.contentNode;
  if (content.type === nodes.divider) return false;
  let target = ctx.contentPos + 1 + content.content.size;
  if (content.type === nodes.codeBlock) {
    const offset = state.selection.head - (ctx.contentPos + 1);
    const nl = content.textContent.indexOf("\n", offset);
    if (nl !== -1) target = ctx.contentPos + 1 + nl;
  }
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView());
  return true;
};

const CODE_INDENT = "  ";

export const codeIndent: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx || ctx.contentNode.type !== nodes.codeBlock) return false;
  dispatch?.(state.tr.insertText(CODE_INDENT).scrollIntoView());
  return true;
};

// §4.3: code の indent を減らす。行頭で減らせなくても block outdent にはしない。
export const codeOutdent: Command = (state, dispatch) => {
  const ctx = getBlockContext(state.selection.$from);
  if (!ctx || ctx.contentNode.type !== nodes.codeBlock) return false;
  const textStart = ctx.contentPos + 1;
  const text = ctx.contentNode.textContent;
  const cursorOffset = state.selection.from - textStart;
  const lineStart = text.lastIndexOf("\n", cursorOffset - 1) + 1;
  let removable = 0;
  while (removable < CODE_INDENT.length && text[lineStart + removable] === " ") removable++;
  if (removable > 0 && dispatch) {
    dispatch(state.tr.delete(textStart + lineStart, textStart + lineStart + removable));
  }
  return true;
};
