import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { nodes } from "./schema";
import {
  blockIndex,
  containerById,
  getBlockContext,
  rangeFromIds,
  visibleContainers,
} from "./context";
import { deleteRange, duplicateRange, indentRange, moveRange, outdentRange } from "./commands";
import {
  blockSelectionKey,
  clearBlockSelection,
  selectBlocks,
  type BlockSelectionMeta,
  type BlockSelectionState,
} from "./selection-state";

const EMPTY: BlockSelectionState = { anchorId: null, headId: null, selectedIds: [] };

type ChainEntry = { groupPos: number; index: number };

function ancestorChain(doc: PMNode, containerPos: number): ChainEntry[] {
  // containerPos + 1 は container 直下なので、container 自身は depth === $pos.depth に現れる
  const $pos = doc.resolve(containerPos + 1);
  const chain: ChainEntry[] = [];
  for (let depth = 2; depth <= $pos.depth; depth++) {
    if ($pos.node(depth).type !== nodes.blockContainer) continue;
    chain.push({ groupPos: $pos.before(depth - 1), index: $pos.index(depth - 1) });
  }
  return chain;
}

// anchor/head をトップレベル選択へ正規化する（TODO.md §1.4/§7.1）。
// 共通の blockGroup まで持ち上げ、そこでの連続 index 範囲を selectedIds にする。
function normalize(doc: PMNode, anchorId: string, headId: string): BlockSelectionState {
  const anchor = containerById(doc, anchorId);
  const head = containerById(doc, headId);
  if (!anchor || !head) return EMPTY;
  const chainA = ancestorChain(doc, anchor.pos);
  const chainB = ancestorChain(doc, head.pos);
  let level = 0;
  while (
    level < chainA.length - 1 &&
    level < chainB.length - 1 &&
    chainA[level].groupPos === chainB[level].groupPos &&
    chainA[level].index === chainB[level].index
  ) {
    level++;
  }
  if (chainA[level].groupPos !== chainB[level].groupPos) return EMPTY;
  const groupPos = chainA[level].groupPos;
  const group = doc.nodeAt(groupPos);
  if (!group) return EMPTY;
  const from = Math.min(chainA[level].index, chainB[level].index);
  const to = Math.max(chainA[level].index, chainB[level].index);
  const selectedIds: string[] = [];
  for (let i = from; i <= to; i++) {
    const id = group.child(i).attrs.id as string | null;
    if (id) selectedIds.push(id);
  }
  return { anchorId, headId, selectedIds };
}

function dispatchRangeOp(
  view: EditorView,
  state: BlockSelectionState,
  build: (
    editorState: EditorState,
    range: NonNullable<ReturnType<typeof rangeFromIds>>,
  ) => Transaction | null,
): boolean {
  const range = rangeFromIds(view.state, state.selectedIds);
  if (!range) return true;
  const tr = build(view.state, range);
  if (tr) view.dispatch(tr.scrollIntoView());
  return true;
}

function selectCurrentBlock(view: EditorView): boolean {
  const ctx = getBlockContext(view.state.selection.$from);
  const id = ctx?.containerNode.attrs.id as string | null | undefined;
  if (!id) return false;
  view.dispatch(selectBlocks(view.state.tr, id, id));
  return true;
}

function selectAllRootBlocks(view: EditorView): boolean {
  const root = view.state.doc.child(0);
  const first = root.child(0).attrs.id as string | null;
  const last = root.child(root.childCount - 1).attrs.id as string | null;
  if (!first || !last) return false;
  view.dispatch(selectBlocks(view.state.tr, first, last));
  return true;
}

function moveVisible(
  view: EditorView,
  state: BlockSelectionState,
  dir: 1 | -1,
  extend: boolean,
): boolean {
  const headId = state.headId;
  if (!headId) return true;
  const visible = visibleContainers(view.state.doc);
  const idx = visible.findIndex((v) => v.id === headId);
  if (idx === -1) return true;
  const next = visible[idx + dir];
  if (!next) return true;
  const anchorId = extend ? (state.anchorId ?? headId) : next.id;
  view.dispatch(selectBlocks(view.state.tr, anchorId, next.id));
  return true;
}

// text cursor からの ↑/↓ で隣の divider を選択状態にする（しずかなインターネット風）。
// divider はカーソルを持てないため、素通りせず一度「選択」で止まる。
function selectAdjacentDivider(view: EditorView, dir: 1 | -1): boolean {
  const sel = view.state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return false;
  if (!view.endOfTextblock(dir === 1 ? "down" : "up")) return false;
  const ctx = getBlockContext(sel.$from);
  const id = ctx?.containerNode.attrs.id as string | null | undefined;
  if (!id) return false;
  const visible = visibleContainers(view.state.doc);
  const idx = visible.findIndex((v) => v.id === id);
  const next = idx === -1 ? undefined : visible[idx + dir];
  if (!next || next.node.child(0).type !== nodes.divider) return false;
  view.dispatch(selectBlocks(view.state.tr, next.id, next.id));
  return true;
}

// 選択中の divider から ↑/↓ で抜けて隣の text block へカーソルを移す。
// 隣も divider なら選択を移す。divider 以外の選択では null（既存の移動処理へ）。
function stepOffDivider(view: EditorView, id: string, dir: 1 | -1): boolean | null {
  const entry = containerById(view.state.doc, id);
  if (!entry || entry.node.child(0).type !== nodes.divider) return null;
  const visible = visibleContainers(view.state.doc);
  const idx = visible.findIndex((v) => v.id === id);
  const target = idx === -1 ? undefined : visible[idx + dir];
  if (!target) return true;
  const content = target.node.child(0);
  if (content.type === nodes.divider) {
    view.dispatch(selectBlocks(view.state.tr, target.id, target.id));
    return true;
  }
  const tr = view.state.tr;
  const pos = dir === 1 ? target.pos + 2 : target.pos + 2 + content.content.size;
  tr.setSelection(TextSelection.create(tr.doc, pos));
  view.dispatch(clearBlockSelection(tr).scrollIntoView());
  view.focus();
  return true;
}

function enterEditMode(view: EditorView, state: BlockSelectionState): boolean {
  const id = state.headId ?? state.selectedIds[0];
  const entry = id ? containerById(view.state.doc, id) : null;
  const tr = view.state.tr;
  if (entry && entry.node.child(0).type !== nodes.divider) {
    const content = entry.node.child(0);
    tr.setSelection(TextSelection.create(tr.doc, entry.pos + 2 + content.content.size));
  }
  view.dispatch(clearBlockSelection(tr));
  view.focus();
  return true;
}

export function blockSelectionPlugin(): Plugin<BlockSelectionState> {
  return new Plugin<BlockSelectionState>({
    key: blockSelectionKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const meta = tr.getMeta(blockSelectionKey) as BlockSelectionMeta | undefined;
        if (meta?.type === "set") return normalize(tr.doc, meta.anchorId, meta.headId);
        if (meta?.type === "clear") return EMPTY;
        if (value.selectedIds.length === 0) return value;
        // text selection への遷移（クリック・入力）で block mode を解除
        if (tr.selectionSet) return EMPTY;
        if (tr.docChanged && value.anchorId && value.headId) {
          return normalize(tr.doc, value.anchorId, value.headId);
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const sel = blockSelectionKey.getState(state);
        if (!sel || sel.selectedIds.length === 0) return null;
        const index = blockIndex(state.doc);
        const decorations: Decoration[] = [];
        for (const id of sel.selectedIds) {
          const pos = index.get(id);
          if (pos === undefined) continue;
          const node = state.doc.nodeAt(pos);
          if (!node) continue;
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, { class: "jb-block-selected" }),
          );
        }
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        const state = blockSelectionKey.getState(view.state) ?? EMPTY;
        const active = state.selectedIds.length > 0;
        const mod = event.metaKey || event.ctrlKey;

        if (!active) {
          // §7.2: Esc / Cmd-A 1回目は現在 block を選択（Ctrl-A は行頭移動に使うため対象外）
          if (event.key === "Escape") return selectCurrentBlock(view);
          if (event.metaKey && !event.shiftKey && !event.altKey && event.key === "a") {
            return selectCurrentBlock(view);
          }
          if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            !mod &&
            !event.shiftKey &&
            !event.altKey
          ) {
            return selectAdjacentDivider(view, event.key === "ArrowDown" ? 1 : -1);
          }
          return false;
        }

        switch (event.key) {
          case "Escape":
            view.dispatch(clearBlockSelection(view.state.tr));
            return true;
          case "Enter":
            return enterEditMode(view, state);
          case "Backspace":
          case "Delete":
            return dispatchRangeOp(view, state, (s, range) => deleteRange(s, range));
          case "Tab":
            return dispatchRangeOp(view, state, (s, range) =>
              event.shiftKey ? outdentRange(s, range) : indentRange(s, range),
            );
          case "ArrowDown":
          case "ArrowUp": {
            const dir = event.key === "ArrowDown" ? 1 : -1;
            if (mod && event.shiftKey) {
              return dispatchRangeOp(view, state, (s, range) =>
                moveRange(s, range, dir === 1 ? "down" : "up"),
              );
            }
            if (!mod && !event.shiftKey && state.selectedIds.length === 1) {
              const stepped = stepOffDivider(view, state.selectedIds[0], dir);
              if (stepped !== null) return stepped;
            }
            return moveVisible(view, state, dir, event.shiftKey);
          }
          case "d":
            if (event.metaKey && !event.shiftKey) {
              return dispatchRangeOp(view, state, (s, range) => duplicateRange(s, range));
            }
            return false;
          case "a":
            if (event.metaKey && !event.shiftKey) return selectAllRootBlocks(view);
            return false;
          default:
            return false;
        }
      },
    },
  });
}
