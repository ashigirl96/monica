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

export function menuItemButton(opts: {
  icon: HTMLElement;
  label: string;
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
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", opts.onPick);
  return button;
}
