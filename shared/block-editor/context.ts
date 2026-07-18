import type { Node as PMNode, ResolvedPos } from "@milkdown/kit/prose/model";
import type { EditorState } from "@milkdown/kit/prose/state";
import { nodes } from "./schema";

// TODO.md §2 getBlockContext。position は selection 由来の ResolvedPos から
// 最も近い blockContainer を見つける。
export type BlockContext = {
  containerPos: number;
  containerNode: PMNode;
  contentPos: number;
  contentNode: PMNode;
  groupPos: number;
  groupNode: PMNode;
  parentContainerPos: number | null;
  siblingIndex: number;
  depth: number;
};

export function getBlockContext($pos: ResolvedPos): BlockContext | null {
  for (let depth = $pos.depth; depth >= 2; depth--) {
    if ($pos.node(depth).type !== nodes.blockContainer) continue;
    const containerNode = $pos.node(depth);
    const containerPos = $pos.before(depth);
    const groupDepth = depth - 1;
    return {
      containerPos,
      containerNode,
      contentPos: containerPos + 1,
      contentNode: containerNode.child(0),
      groupPos: $pos.before(groupDepth),
      groupNode: $pos.node(groupDepth),
      parentContainerPos: groupDepth >= 2 ? $pos.before(groupDepth - 1) : null,
      siblingIndex: $pos.index(groupDepth),
      depth,
    };
  }
  return null;
}

// TODO.md §1.4: position は Transaction で変わるため、UI 状態は ID 基準。
// index は doc ごとに一度だけ計算して WeakMap でメモ化する。
const indexCache = new WeakMap<PMNode, Map<string, number>>();

export function blockIndex(doc: PMNode): Map<string, number> {
  const cached = indexCache.get(doc);
  if (cached) return cached;
  const map = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type !== nodes.blockContainer) return true;
    const id = node.attrs.id as string | null;
    if (id !== null && !map.has(id)) map.set(id, pos);
    return true;
  });
  indexCache.set(doc, map);
  return map;
}

export function containerById(doc: PMNode, id: string): { pos: number; node: PMNode } | null {
  const pos = blockIndex(doc).get(id);
  if (pos === undefined) return null;
  const node = doc.nodeAt(pos);
  if (!node || node.type !== nodes.blockContainer) return null;
  return { pos, node };
}

// id の block を子に持つ親 blockContainer の id。トップレベルなら null。
export function parentContainerId(doc: PMNode, id: string): string | null {
  const entry = containerById(doc, id);
  if (!entry) return null;
  const parent = getBlockContext(doc.resolve(entry.pos));
  return (parent?.containerNode.attrs.id as string | null) ?? null;
}

// 可視 blockContainer を pre-order で列挙する。closed toggle の配下は skip
// （TODO.md §7.4)。
export function visibleContainers(doc: PMNode): Array<{ id: string; pos: number; node: PMNode }> {
  const out: Array<{ id: string; pos: number; node: PMNode }> = [];
  const walk = (parent: PMNode, base: number) => {
    parent.forEach((child, offset) => {
      const pos = base + offset;
      if (child.type === nodes.blockGroup) {
        walk(child, pos + 1);
        return;
      }
      if (child.type !== nodes.blockContainer) return;
      const id = child.attrs.id as string | null;
      if (id !== null) out.push({ id, pos, node: child });
      const content = child.child(0);
      const collapsed = content.type === nodes.toggle && content.attrs.open === false;
      if (!collapsed && child.childCount > 1) walk(child.child(1), pos + 1 + content.nodeSize + 1);
    });
  };
  walk(doc.child(0), 1);
  return out;
}

// 連続兄弟レンジ: 構造 command が操作する単位（TODO.md §3.4 MVP）。
export type SiblingRange = {
  groupPos: number;
  groupNode: PMNode;
  fromIndex: number;
  toIndex: number;
  parentContainerPos: number | null;
};

export function rangeFromContext(ctx: BlockContext): SiblingRange {
  return {
    groupPos: ctx.groupPos,
    groupNode: ctx.groupNode,
    fromIndex: ctx.siblingIndex,
    toIndex: ctx.siblingIndex,
    parentContainerPos: ctx.parentContainerPos,
  };
}

// selectedIds（正規化済み: 同一 group の連続 top-level 選択）を SiblingRange へ。
export function rangeFromIds(state: EditorState, ids: readonly string[]): SiblingRange | null {
  if (ids.length === 0) return null;
  const first = containerById(state.doc, ids[0]);
  if (!first) return null;
  const $first = state.doc.resolve(first.pos + 1);
  const ctx = getBlockContext($first);
  if (!ctx) return null;
  const idSet = new Set(ids);
  let fromIndex = -1;
  let toIndex = -1;
  ctx.groupNode.forEach((child, _offset, index) => {
    if (!idSet.has(child.attrs.id as string)) return;
    if (fromIndex === -1) fromIndex = index;
    toIndex = index;
  });
  if (fromIndex === -1) return null;
  return {
    groupPos: ctx.groupPos,
    groupNode: ctx.groupNode,
    fromIndex,
    toIndex,
    parentContainerPos: ctx.parentContainerPos,
  };
}

export function childStartPos(parentPos: number, parent: PMNode, index: number): number {
  let pos = parentPos + 1;
  for (let i = 0; i < index; i++) pos += parent.child(i).nodeSize;
  return pos;
}

export function rangePositions(range: SiblingRange): { start: number; end: number } {
  const start = childStartPos(range.groupPos, range.groupNode, range.fromIndex);
  let end = start;
  for (let i = range.fromIndex; i <= range.toIndex; i++) end += range.groupNode.child(i).nodeSize;
  return { start, end };
}
