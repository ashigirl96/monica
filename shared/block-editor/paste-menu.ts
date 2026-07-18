import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createContainer, nodes } from "./schema";
import {
  createMenuOverlay,
  handleMenuNavKey,
  menuItemButton,
  positionMenuAt,
} from "./menu-overlay";
import { pasteMenuKey } from "./menu-keys";

// Notion の paste メニュー同様、↑↓で選んだ表現を doc に即時反映（ライブプレビュー）し、
// Enter は「表示中の状態をそのまま確定」する。メニュー表示中の doc 変更は preview
// 経由（set meta 同梱）で行い、それ以外の doc 変更は「そのまま確定」として閉じる。
export type PasteMenuActiveState = {
  active: true;
  /** 挿入 range の先頭。start より前は触らないので全遷移を通じて安定アンカー。 */
  start: number;
  /** 現在挿入されている表現の合計 nodeSize。 */
  size: number;
  /** 0 = Paste（plain）, 1 = Paste and sync */
  index: number;
  plain: PMNode[];
  synced: PMNode[];
};

export type PasteMenuState = { active: false } | PasteMenuActiveState;

type PasteMenuMeta =
  | { type: "open"; start: number; plain: PMNode[]; synced: PMNode[] }
  | { type: "close" }
  | { type: "set"; state: PasteMenuActiveState };

type PasteMenuItem = { kind: "paste" | "sync"; label: string };

const ITEMS: PasteMenuItem[] = [
  { kind: "paste", label: "Paste" },
  { kind: "sync", label: "Paste and sync" },
];

function totalSize(nodesList: readonly PMNode[]): number {
  return nodesList.reduce((sum, node) => sum + node.nodeSize, 0);
}

/** copy 元の選択範囲全体を 1 つの synced ミラー（Notion 準拠）にまとめる。
    単一 synced block の複製は参照先（noteId, blockIds）を引き継いでチェーン化を防ぐ。 */
export function buildSyncedContainer(originals: readonly PMNode[], sourceNoteId: string): PMNode {
  const single = originals.length === 1 ? originals[0] : null;
  const singleContent = single && single.childCount > 0 ? single.child(0) : null;
  if (singleContent && singleContent.type === nodes.syncedBlock) {
    return createContainer(
      nodes.syncedBlock.create({
        noteId: singleContent.attrs.noteId as string,
        blockIds: singleContent.attrs.blockIds as string[],
      }),
    );
  }
  const blockIds = originals
    .map((container) => container.attrs.id as string | null)
    .filter((id): id is string => id !== null);
  return createContainer(nodes.syncedBlock.create({ noteId: sourceNoteId, blockIds }));
}

/** clipboard の paste Transaction にメニュー表示を相乗りさせる（plain は既に挿入済み）。 */
export function openPasteMenu(
  tr: Transaction,
  args: { start: number; plain: PMNode[]; synced: PMNode[] },
): Transaction {
  return tr.setMeta(pasteMenuKey, {
    type: "open",
    start: args.start,
    plain: args.plain,
    synced: args.synced,
  } satisfies PasteMenuMeta);
}

/** 現在の表現を target index の表現に置き換える（start より前は不変）。 */
export function previewPasteTransaction(
  state: EditorState,
  s: PasteMenuActiveState,
  targetIndex: number,
): { tr: Transaction; next: PasteMenuActiveState } | null {
  const target = targetIndex === 1 ? s.synced : s.plain;
  if (target.length === 0) return null;
  const tr = state.tr.replaceWith(s.start, s.start + s.size, target);
  return { tr, next: { ...s, index: targetIndex, size: totalSize(target) } };
}

function close(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(pasteMenuKey, { type: "close" } satisfies PasteMenuMeta));
}

function preview(view: EditorView, index: number): void {
  const s = pasteMenuKey.getState(view.state);
  if (!s?.active || s.index === index) return;
  const res = previewPasteTransaction(view.state, s, index);
  if (!res) return;
  res.tr.setMeta(pasteMenuKey, { type: "set", state: res.next } satisfies PasteMenuMeta);
  view.dispatch(res.tr.scrollIntoView());
}

function confirm(view: EditorView): void {
  close(view);
  view.focus();
}

/** Escape: plain（index 0）に戻して閉じる。 */
function dismiss(view: EditorView): void {
  const s = pasteMenuKey.getState(view.state);
  if (!s?.active) return;
  let tr = view.state.tr;
  if (s.index !== 0) {
    const res = previewPasteTransaction(view.state, s, 0);
    if (res) tr = res.tr;
  }
  tr.setMeta(pasteMenuKey, { type: "close" } satisfies PasteMenuMeta);
  view.dispatch(tr);
  view.focus();
}

function pickItem(view: EditorView, index: number): void {
  preview(view, index);
  confirm(view);
}

class PasteMenuView {
  private menu: HTMLElement;

  constructor(private view: EditorView) {
    this.menu = createMenuOverlay(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const state = pasteMenuKey.getState(view.state);
    if (!state?.active) {
      this.menu.style.display = "none";
      return;
    }
    this.menu.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "jb-slash-heading";
    heading.textContent = "Paste as";
    this.menu.append(heading);
    ITEMS.forEach((item, i) => {
      const glyph = document.createElement("span");
      glyph.className = "jb-glyph";
      glyph.dataset.kind = item.kind;
      this.menu.append(
        menuItemButton({
          icon: glyph,
          label: item.label,
          active: i === state.index,
          onPick: () => pickItem(this.view, i),
        }),
      );
    });
    positionMenuAt(this.view, this.menu, state.start);
  }

  destroy(): void {
    this.menu.remove();
  }
}

export function pasteMenuPlugin(): Plugin<PasteMenuState> {
  return new Plugin<PasteMenuState>({
    key: pasteMenuKey,
    state: {
      init: (): PasteMenuState => ({ active: false }),
      apply(tr, value): PasteMenuState {
        const meta = tr.getMeta(pasteMenuKey) as PasteMenuMeta | undefined;
        if (meta?.type === "open") {
          return {
            active: true,
            start: meta.start,
            size: totalSize(meta.plain),
            index: 0,
            plain: meta.plain,
            synced: meta.synced,
          };
        }
        if (meta?.type === "close") return { active: false };
        if (!value.active) return value;
        if (meta?.type === "set") return meta.state;
        // メニュー由来でない doc 変更（タイピング等）は「そのまま確定」として閉じる
        if (tr.docChanged) return { active: false };
        return value;
      },
    },
    props: {
      handleKeyDown(view, event) {
        const state = pasteMenuKey.getState(view.state);
        if (!state?.active) return false;
        return handleMenuNavKey(event, state.index, {
          itemCount: ITEMS.length,
          onClose: () => dismiss(view),
          onNav: (index) => preview(view, index),
          onPick: () => confirm(view),
        });
      },
      handleDOMEvents: {
        // エディタ本文へのクリックは現在の表現のまま確定（メニュー overlay は view.dom
        // の外なので、項目ボタンのクリックはここに来ない）
        mousedown(view) {
          if (pasteMenuKey.getState(view.state)?.active) confirm(view);
          return false;
        },
      },
    },
    view: (view) => new PasteMenuView(view),
  });
}
