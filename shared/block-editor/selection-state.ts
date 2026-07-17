import { PluginKey } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";

// TODO.md §1.4 / §7.1: block selection は plugin state + Decoration。
// selectedIds は常にトップレベル選択のみ（選択済み親の子孫を含めない）。
export type BlockSelectionState = {
  anchorId: string | null;
  headId: string | null;
  selectedIds: string[];
};

export type BlockSelectionMeta =
  | { type: "set"; anchorId: string; headId: string }
  | { type: "clear" };

export const blockSelectionKey = new PluginKey<BlockSelectionState>("journalBlockSelection");

export function selectBlocks(tr: Transaction, anchorId: string, headId: string): Transaction {
  return tr.setMeta(blockSelectionKey, {
    type: "set",
    anchorId,
    headId,
  } satisfies BlockSelectionMeta);
}

export function clearBlockSelection(tr: Transaction): Transaction {
  return tr.setMeta(blockSelectionKey, { type: "clear" } satisfies BlockSelectionMeta);
}
