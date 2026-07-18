import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { containerById } from "./context";

const blockHighlightKey = new PluginKey<string | null>("journalBlockHighlight");

/** id の block を一時ハイライト対象にする（synced block からのジャンプ後）。 */
export function highlightBlock(tr: Transaction, id: string): Transaction {
  return tr.setMeta(blockHighlightKey, id);
}

export function clearBlockHighlight(tr: Transaction): Transaction {
  return tr.setMeta(blockHighlightKey, null);
}

// ハイライト対象 id を state に保持し、対応する blockContainer に node decoration を張る。
// meta が来たときだけ更新し、通常の docChanged では id を保ったまま位置追従させる。
export function blockHighlightPlugin(): Plugin<string | null> {
  return new Plugin<string | null>({
    key: blockHighlightKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(blockHighlightKey);
        if (meta !== undefined) return meta as string | null;
        return value;
      },
    },
    props: {
      decorations(state) {
        const id = blockHighlightKey.getState(state);
        if (!id) return null;
        const entry = containerById(state.doc, id);
        if (!entry) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(entry.pos, entry.pos + entry.node.nodeSize, {
            class: "jb-block-highlight",
          }),
        ]);
      },
    },
  });
}
