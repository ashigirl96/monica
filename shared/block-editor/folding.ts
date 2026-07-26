import { Fragment } from "@milkdown/kit/prose/model";
import type { Node as PMNode, ResolvedPos } from "@milkdown/kit/prose/model";
import type { Transaction } from "@milkdown/kit/prose/state";
import { nodes } from "./schema";

// 折りたたみの判定・範囲導出・開示操作をここに集約する。callout / toggle は構造上の子
// blockGroup を隠すだけだが、heading は doc 上の子を持たない（`## ` 直後の段落は兄弟）
// ため「後続兄弟のうち次の同レベル以上 heading の手前まで」を範囲とする。範囲が attr
// ではなく内容から毎回導出されるので、範囲へ block やカーソルを送り込む操作は支配
// heading を開く（expandedHeading / revealPos）。
// 「畳まれているか」を toggle は open、heading / callout は collapsed で表す差は
// foldAttrOf に閉じ込め、外へは出さない。

/** 折りたたみ可能な heading。h1 はセクション境界としてのみ扱い、畳めない。 */
export function isFoldableHeading(content: PMNode): boolean {
  if (content.type !== nodes.heading) return false;
  const level = Number(content.attrs.level);
  return level === 2 || level === 3;
}

type FoldAttr = "open" | "collapsed";

function foldAttrOf(content: PMNode): FoldAttr | null {
  if (content.type === nodes.toggle) return "open";
  return content.type === nodes.callout || isFoldableHeading(content) ? "collapsed" : null;
}

/** ▾ ボタンを出す blockContent。toggle は専用の ToggleView が担うので含めない。 */
export function isFoldableContent(content: PMNode): boolean {
  return foldAttrOf(content) === "collapsed";
}

/** blockContent が折りたたまれているか。 */
export function isFoldedContent(content: PMNode): boolean {
  const attr = foldAttrOf(content);
  return attr !== null && content.attrs[attr] === (attr === "collapsed");
}

/** container 直下の blockGroup が折りたたみで隠れているか。 */
export function isCollapsedContainer(container: PMNode): boolean {
  return isFoldedContent(container.child(0));
}

/** 折りたたみ状態を書く。 */
export function setFolded(
  tr: Transaction,
  content: PMNode,
  contentPos: number,
  folded: boolean,
): void {
  const attr = foldAttrOf(content);
  if (attr !== null) tr.setNodeAttribute(contentPos, attr, attr === "collapsed" ? folded : !folded);
}

/** 折りたたまれた blockContent を開いた複製。開いていれば同一参照を返す。 */
export function expandedContent(content: PMNode): PMNode {
  const attr = foldAttrOf(content);
  if (attr === null || !isFoldedContent(content)) return content;
  return content.type.create({ ...content.attrs, [attr]: attr === "open" }, content.content);
}

/** heading だけ畳みを解く。callout / toggle は隠す対象が構造上の子なので一緒に動く。 */
export function expandedHeading(content: PMNode): PMNode {
  return isFoldableHeading(content) ? expandedContent(content) : content;
}

/** subtree 全体の heading の畳みを解く。heading が隠すのは後続兄弟なので、畳んだまま
    別の場所へ貼ると貼り先の無関係な block まで隠れてしまう。 */
export function expandedHeadingsDeep(node: PMNode): PMNode {
  if (node.type !== nodes.blockContainer && node.type !== nodes.blockGroup)
    return expandedHeading(node);
  return node.copy(Fragment.fromArray(node.content.content.map(expandedHeadingsDeep)));
}

/** index を section に含む heading（外側 → 内側）。 */
type Dominator = { level: number; contentPos: number; content: PMNode; collapsed: boolean };

// 兄弟列を前から走査し、各 index とそれを支配する heading の連鎖を visit へ渡す。
// 同レベル以上の heading が section を終端するので、連鎖は level 昇順に保たれる
// （h3 の section は必ず h2 の section に含まれる）。visit が false を返すと打ち切る。
function scanFolds(
  siblings: readonly PMNode[],
  basePos: number,
  visit: (index: number, dominators: readonly Dominator[]) => boolean | void,
): void {
  const stack: Dominator[] = [];
  let pos = basePos;
  for (let index = 0; index < siblings.length; index++) {
    const content = siblings[index].child(0);
    const level = content.type === nodes.heading ? Number(content.attrs.level) : null;
    if (level !== null)
      while (stack.length > 0 && level <= stack[stack.length - 1].level) stack.pop();
    if (visit(index, stack) === false) return;
    if (level !== null && isFoldableHeading(content))
      stack.push({
        level,
        contentPos: pos + 1,
        content,
        collapsed: content.attrs.collapsed === true,
      });
    pos += siblings[index].nodeSize;
  }
}

/** 兄弟 container 列のうち、折りたたまれた heading に隠される index の集合。 */
export function foldedSiblingIndexes(siblings: readonly PMNode[]): Set<number> {
  const hidden = new Set<number>();
  scanFolds(siblings, 0, (index, dominators) => {
    if (dominators.some((d) => d.collapsed)) hidden.add(index);
  });
  return hidden;
}

// group は immutable なので doc ごとの再計算を避ける（context.ts の blockIndex と同じ流儀）。
const foldedCache = new WeakMap<PMNode, Set<number>>();

/** blockGroup 版の foldedSiblingIndexes。 */
export function foldedIndexes(group: PMNode): Set<number> {
  const cached = foldedCache.get(group);
  if (cached) return cached;
  const hidden = foldedSiblingIndexes(group.content.content);
  foldedCache.set(group, hidden);
  return hidden;
}

function dominatorsAt(group: PMNode, groupPos: number, index: number): readonly Dominator[] {
  let found: readonly Dominator[] = [];
  scanFolds(group.content.content, groupPos + 1, (i, dominators) => {
    if (i < index) return;
    found = [...dominators];
    return false;
  });
  return found;
}

/** pos を含む blockContainer が折りたたみで不可視か。 */
export function isPosHidden(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (node.type === nodes.blockGroup) {
      if (foldedIndexes(node).has($pos.index(depth))) return true;
      // index 1 = blockContent ではなく子 blockGroup へ降りている
    } else if (node.type === nodes.blockContainer && $pos.index(depth) === 1) {
      if (isCollapsedContainer(node)) return true;
    }
  }
  return false;
}

/** pos を可視にするのに必要な折りたたみを開く。何か開いたら true。
    setNodeAttribute は nodeSize を変えないので、以降の position は不変。 */
export function revealPos(tr: Transaction, pos: number): boolean {
  const $pos = tr.doc.resolve(pos);
  let opened = false;
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (node.type === nodes.blockGroup) {
      for (const d of dominatorsAt(node, $pos.before(depth), $pos.index(depth))) {
        if (!d.collapsed) continue;
        setFolded(tr, d.content, d.contentPos, false);
        opened = true;
      }
    } else if (node.type === nodes.blockContainer && $pos.index(depth) === 1) {
      if (!isCollapsedContainer(node)) continue;
      setFolded(tr, node.child(0), $pos.before(depth) + 1, false);
      opened = true;
    }
  }
  return opened;
}

export type FoldTarget = { containerPos: number; contentPos: number; content: PMNode };

/** ⌥. の開閉対象。内側の container から順に、自分が折りたためるか・同 group の
    前方に自分を section に含む heading がいるかを見る。 */
export function resolveFoldTarget($pos: ResolvedPos): FoldTarget | null {
  for (let depth = $pos.depth; depth >= 2; depth--) {
    const container = $pos.node(depth);
    if (container.type !== nodes.blockContainer) continue;
    const content = container.child(0);
    if (foldAttrOf(content) !== null) {
      const containerPos = $pos.before(depth);
      return { containerPos, contentPos: containerPos + 1, content };
    }
    const groupDepth = depth - 1;
    const innermost = dominatorsAt(
      $pos.node(groupDepth),
      $pos.before(groupDepth),
      $pos.index(groupDepth),
    ).at(-1);
    if (innermost)
      return {
        containerPos: innermost.contentPos - 1,
        contentPos: innermost.contentPos,
        content: innermost.content,
      };
  }
  return null;
}
