import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";
import { emptyParagraphContainer, newBlockId, nodes } from "./schema";

const normalizerKey = new PluginKey("journalNormalizer");

// TODO.md §12.2: appendTransaction は最終防衛に限定する。
// 修復対象: missing ID / duplicate ID / empty blockGroup / empty doc。
export function normalizerPlugin(): Plugin {
  return new Plugin({
    key: normalizerKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.every((tr) => tr.getMeta(normalizerKey))) return null;

      let tr: Transaction | null = null;
      const ensure = () => (tr ??= newState.tr.setMeta(normalizerKey, true));

      const seen = new Set<string>();
      newState.doc.descendants((node, pos) => {
        if (node.type === nodes.blockGroup && node.childCount === 0) {
          // schema 上 blockContainer+ なので通常到達しないが、防衛として削除
          ensure().delete(tr!.mapping.map(pos), tr!.mapping.map(pos + node.nodeSize));
          return false;
        }
        if (node.type !== nodes.blockContainer) return true;
        const id = node.attrs.id as string | null;
        if (id === null || seen.has(id)) {
          ensure().setNodeAttribute(tr!.mapping.map(pos), "id", newBlockId());
        } else {
          seen.add(id);
        }
        return true;
      });

      const root = newState.doc.child(0);
      if (root.childCount === 0) {
        ensure().insert(tr!.mapping.map(1), emptyParagraphContainer());
      }

      return tr;
    },
  });
}
