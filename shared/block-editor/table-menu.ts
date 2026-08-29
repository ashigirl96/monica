import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { Command } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getTableCellContext } from "./table";
import {
  tableDeleteColumn,
  tableDeleteRow,
  tableInsertColumnLeft,
  tableInsertColumnRight,
  tableInsertRowAbove,
  tableInsertRowBelow,
} from "./table-ops";
import {
  createMenuOverlay,
  handleMenuNavKey,
  menuItemButton,
  positionMenuAtPoint,
} from "./menu-overlay";
import { linkMenuKey, noteMentionMenuKey, pasteMenuKey, tableMenuKey } from "./menu-keys";

// セル右クリックで開く行・列の操作メニュー。slash menu は table 内で開かない
// （applyItem の replaceWith が表全体を置換してしまう）ので、表の構造編集はここが唯一の入口。

export type TableMenuState =
  | { active: false }
  | { active: true; x: number; y: number; index: number };

type TableMenuMeta =
  | { type: "open"; x: number; y: number }
  | { type: "nav"; index: number }
  | { type: "close" };

type TableMenuItem = {
  kind: "row" | "column" | "trash";
  label: string;
  command: Command;
  destructive?: boolean;
  separatorBefore?: boolean;
};

export const TABLE_MENU_ITEMS: TableMenuItem[] = [
  { kind: "row", label: "Insert row above", command: tableInsertRowAbove },
  { kind: "row", label: "Insert row below", command: tableInsertRowBelow },
  { kind: "column", label: "Insert column left", command: tableInsertColumnLeft },
  { kind: "column", label: "Insert column right", command: tableInsertColumnRight },
  {
    kind: "trash",
    label: "Delete row",
    command: tableDeleteRow,
    destructive: true,
    separatorBefore: true,
  },
  { kind: "trash", label: "Delete column", command: tableDeleteColumn, destructive: true },
];

function close(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(tableMenuKey, { type: "close" } satisfies TableMenuMeta));
}

function pick(view: EditorView, index: number): void {
  const item = TABLE_MENU_ITEMS[index];
  const ran = item.command(view.state, (tr) =>
    view.dispatch(tr.setMeta(tableMenuKey, { type: "close" } satisfies TableMenuMeta)),
  );
  if (!ran) close(view);
  view.focus();
}

class TableMenuView {
  private menu: HTMLElement;
  private listening = false;

  constructor(private view: EditorView) {
    this.menu = createMenuOverlay(view);
  }

  // overlay は view.dom の外なので、editor 本文以外（sidebar 等）のクリックは
  // handleDOMEvents に来ない。window で拾って閉じる
  private onWindowMouseDown = (e: MouseEvent) => {
    if (e.target instanceof Node && this.menu.contains(e.target)) return;
    if (tableMenuKey.getState(this.view.state)?.active) close(this.view);
  };

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    if (on) window.addEventListener("mousedown", this.onWindowMouseDown, true);
    else window.removeEventListener("mousedown", this.onWindowMouseDown, true);
  }

  update(view: EditorView): void {
    this.view = view;
    const state = tableMenuKey.getState(view.state);
    if (!state?.active) {
      this.menu.style.display = "none";
      this.listen(false);
      return;
    }
    this.menu.replaceChildren();
    TABLE_MENU_ITEMS.forEach((item, i) => {
      if (item.separatorBefore) {
        const sep = document.createElement("div");
        sep.className = "jb-slash-separator";
        this.menu.append(sep);
      }
      const glyph = document.createElement("span");
      glyph.className = "jb-glyph";
      glyph.dataset.kind = item.kind;
      this.menu.append(
        menuItemButton({
          icon: glyph,
          label: item.label,
          active: i === state.index,
          destructive: item.destructive,
          onPick: () => pick(this.view, i),
        }),
      );
    });
    positionMenuAtPoint(this.view, this.menu, state.x, state.y);
    this.listen(true);
  }

  destroy(): void {
    this.listen(false);
    this.menu.remove();
  }
}

export function tableMenuPlugin(): Plugin<TableMenuState> {
  return new Plugin<TableMenuState>({
    key: tableMenuKey,
    state: {
      init: (): TableMenuState => ({ active: false }),
      apply(tr, value): TableMenuState {
        const meta = tr.getMeta(tableMenuKey) as TableMenuMeta | undefined;
        // open tr 自身が右クリック先セルへ selection を動かすので、selectionSet 判定より先に見る
        if (meta?.type === "open") return { active: true, x: meta.x, y: meta.y, index: 0 };
        if (meta?.type === "close") return { active: false };
        if (!value.active) return value;
        if (meta?.type === "nav") return { ...value, index: meta.index };
        if (tr.docChanged || tr.selectionSet) return { active: false };
        return value;
      },
    },
    props: {
      handleKeyDown(view, event) {
        const state = tableMenuKey.getState(view.state);
        if (!state?.active) return false;
        return handleMenuNavKey(event, state.index, {
          itemCount: TABLE_MENU_ITEMS.length,
          onClose: () => {
            close(view);
            view.focus();
          },
          onNav: (index) =>
            view.dispatch(
              view.state.tr.setMeta(tableMenuKey, { type: "nav", index } satisfies TableMenuMeta),
            ),
          onPick: () => pick(view, state.index),
        });
      },
      handleDOMEvents: {
        contextmenu(view, event) {
          // 他のメニューが開いている間は譲る。同じセル内での右クリックは selection を
          // 動かさないので、開いたままだと両方表示されて矢印 / Enter を奪い合う
          if (
            noteMentionMenuKey.getState(view.state)?.active ||
            pasteMenuKey.getState(view.state)?.active ||
            linkMenuKey.getState(view.state)?.active
          )
            return false;
          const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!found) return false;
          const $pos = view.state.doc.resolve(found.pos);
          const ctx = getTableCellContext($pos);
          // cell 外は native のコンテキストメニューに任せる
          if (!ctx) return false;
          event.preventDefault();
          const tr = view.state.tr;
          const { $from, $to } = view.state.selection;
          const cellFrom = ctx.cellPos + 1;
          const cellTo = ctx.cellPos + ctx.cellNode.nodeSize - 1;
          const selectionInCell = $from.pos >= cellFrom && $to.pos <= cellTo;
          if (!selectionInCell) tr.setSelection(TextSelection.near($pos));
          tr.setMeta(tableMenuKey, {
            type: "open",
            x: event.clientX,
            y: event.clientY,
          } satisfies TableMenuMeta);
          view.dispatch(tr);
          return true;
        },
        mousedown(view) {
          if (tableMenuKey.getState(view.state)?.active) close(view);
          return false;
        },
      },
    },
    view: (view) => new TableMenuView(view),
  });
}
