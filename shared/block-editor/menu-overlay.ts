import type { EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** slash-menu / link-menu 共通のポップアップ chrome（.jb-slash-* スタイルを共有） */
export function createMenuOverlay(view: EditorView): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "jb-slash-menu";
  menu.style.display = "none";
  menu.setAttribute("role", "listbox");
  view.dom.parentElement?.append(menu);
  return menu;
}

// §9.1: coordsAtPos で editor 外 overlay を配置（CSS zoom は比率で補正）
export function positionMenuAt(view: EditorView, menu: HTMLElement, pos: number): void {
  const wrapper = view.dom.parentElement;
  if (!wrapper) return;
  // display を先に立てて layout read（coordsAtPos / offsetTop）をまとめ、style の
  // 書き込みは最後に寄せる — read/write を交互にすると transaction ごとの強制 reflow が増える
  menu.style.display = "block";
  const coords = view.coordsAtPos(pos);
  const wrapperRect = wrapper.getBoundingClientRect();
  const scale = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1;
  const scrollTop = activeItemScrollTop(menu);
  menu.style.left = `${(coords.left - wrapperRect.left) / scale}px`;
  menu.style.top = `${(coords.bottom - wrapperRect.top) / scale + 4}px`;
  if (scrollTop !== null) menu.scrollTop = scrollTop;
}

// element.scrollIntoView は page などの祖先スクローラーまで動かすので menu.scrollTop を直接操作する
function activeItemScrollTop(menu: HTMLElement): number | null {
  const item = menu.querySelector(".jb-slash-item-active");
  if (!(item instanceof HTMLElement)) return null;
  if (item.offsetTop < menu.scrollTop) {
    // 先頭候補では heading ごと見せる
    return item === menu.querySelector(".jb-slash-item") ? 0 : item.offsetTop;
  }
  if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
    return item.offsetTop + item.offsetHeight - menu.clientHeight;
  }
  return null;
}

/** trigger 系メニューの query 追従。selection が trigger 直後〜同一 textblock 内から
    外れたら null（= close）。非空選択も範囲内なら維持する — WebKit は日本語 IME の
    変換中、変換対象の文節を DOM selection として表現するので、非空選択を一律に
    close すると変換のたびにメニューが消える。 */
export function trackedMenuQuery(state: EditorState, pos: number, trigger: string): string | null {
  const { $from, $to } = state.selection;
  const $pos = state.doc.resolve(pos);
  const queryStart = pos + trigger.length;
  // $to が同一 textblock 内で $from が queryStart 以降なら、$from も同一 textblock 内
  if ($to.parent !== $pos.parent || $from.pos < queryStart) return null;
  if (state.doc.textBetween(pos, queryStart) !== trigger) return null;
  return state.doc.textBetween(queryStart, $to.pos);
}

/** trigger 系メニュー共通のキーナビ（Escape / ↑↓ / Ctrl-n・p / Enter / Tab）。
    メニューが key を消費したら true。 */
export function handleMenuNavKey(
  event: KeyboardEvent,
  index: number,
  handlers: {
    itemCount: number;
    onClose: () => void;
    onNav: (index: number) => void;
    /** 現在の index の項目を確定する（項目が無いときの close も呼び手の責務） */
    onPick: () => void;
  },
): boolean {
  if (event.key === "Escape") {
    handlers.onClose();
    return true;
  }
  const down = event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
  const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
  if (down || up) {
    if (handlers.itemCount > 0) {
      const delta = down ? 1 : -1;
      handlers.onNav((index + delta + handlers.itemCount) % handlers.itemCount);
    }
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    handlers.onPick();
    return true;
  }
  return false;
}

export function menuItemButton(opts: {
  icon: HTMLElement;
  label: string;
  /** label の後ろに薄く出すサブラベル（ノートの preview 等） */
  hint?: string;
  active: boolean;
  onPick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "jb-slash-item";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(opts.active));
  if (opts.active) button.classList.add("jb-slash-item-active");
  const icon = document.createElement("span");
  icon.className = "jb-slash-icon";
  icon.append(opts.icon);
  const label = document.createElement("span");
  label.className = "jb-slash-label";
  label.textContent = opts.label;
  button.append(icon, label);
  if (opts.hint) {
    const hint = document.createElement("span");
    hint.className = "jb-slash-hint";
    hint.textContent = opts.hint;
    button.append(hint);
  }
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", opts.onPick);
  return button;
}
