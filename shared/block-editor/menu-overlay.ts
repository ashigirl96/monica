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
  const coords = view.coordsAtPos(pos);
  const wrapperRect = wrapper.getBoundingClientRect();
  const scale = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1;
  menu.style.display = "block";
  menu.style.left = `${(coords.left - wrapperRect.left) / scale}px`;
  menu.style.top = `${(coords.bottom - wrapperRect.top) / scale + 4}px`;
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
