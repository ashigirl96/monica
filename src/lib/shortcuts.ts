import { useEffect, useRef } from "react";

export const KEYMAP = {
  toggleSidebar: { keys: "mod+1", label: "サイドバーの開閉" },
  focusNextTask: { keys: ["arrowdown", "ctrl+n"], label: "次のタスクへ移動" },
  focusPreviousTask: { keys: ["arrowup", "ctrl+p"], label: "前のタスクへ移動" },
  openFocusedTask: { keys: "enter", label: "タスク詳細を開く" },
  closePanel: { keys: "escape", label: "パネルを閉じる" },
  deleteFocusedTask: { keys: "mod+d", label: "タスクを削除" },
  openContextMenu: { keys: " ", label: "コンテキストメニューを開く" },
} as const satisfies Record<string, { keys: string | readonly string[]; label: string }>;

export type ShortcutId = keyof typeof KEYMAP;

type Handlers = Partial<Record<ShortcutId, () => void>>;

function matches(keys: string, e: KeyboardEvent): boolean {
  const parts = keys.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const wantMod = parts.includes("mod");
  const wantCtrl = parts.includes("ctrl");
  if (wantMod) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    if (e.metaKey) return false;
    if (wantCtrl !== e.ctrlKey) return false;
  }
  if (parts.includes("shift") !== e.shiftKey) return false;
  if (parts.includes("alt") !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

function matchesAny(keys: string | readonly string[], e: KeyboardEvent): boolean {
  return typeof keys === "string" ? matches(keys, e) : keys.some((key) => matches(key, e));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"),
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a[href], summary, [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='checkbox'], [role='radio'], [role='switch'], [role='option']",
    ),
  );
}

function isTaskRowTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-task-row='true']"));
}

function shouldIgnoreShortcut(id: ShortcutId, target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  if (
    (id === "openFocusedTask" || id === "openContextMenu") &&
    isInteractiveTarget(target) &&
    !isTaskRowTarget(target)
  ) {
    return true;
  }
  return false;
}

export function useShortcuts(handlers: Handlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      for (const id of Object.keys(latest.current) as ShortcutId[]) {
        const run = latest.current[id];
        if (run && matchesAny(KEYMAP[id].keys, e) && !shouldIgnoreShortcut(id, e.target)) {
          e.preventDefault();
          run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
