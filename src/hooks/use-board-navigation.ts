import { useAtomValue, useStore } from "jotai";
import { useEffect } from "react";
import { isEditable } from "@/lib/keyboard";
import {
  executeMenuItemAtom,
  exitNavAtom,
  focusedPositionAtom,
  focusedTaskIdAtom,
  menuAtom,
  type MenuAnchor,
  moveFocusAtom,
  moveMenuItemAtom,
  openMenuAtom,
  reconcileFocusAtom,
  requestDeleteAtom,
  runDirectActionAtom,
} from "@/stores/workboard-nav";

const NAV_KEYS = { h: "left", j: "down", k: "up", l: "right" } as const;
const ACTION_KEYS = { p: "prepare", r: "run", b: "bench" } as const;

function focusedCardElement(taskId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
}

function focusedCardAnchor(taskId: string | null): MenuAnchor | null {
  const rect = taskId ? focusedCardElement(taskId)?.getBoundingClientRect() : undefined;
  return rect ? { top: rect.top, left: rect.left, bottom: rect.bottom } : null;
}

// Mounted by WorkBoardContent, which unmounts on space switch, so the listener
// only exists while the board is visible and needs no activeSpace guard.
export function useBoardNavigation() {
  const store = useStore();
  const focusedTaskId = useAtomValue(focusedTaskIdAtom);
  const position = useAtomValue(focusedPositionAtom);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || isEditable(e)) return;

      if (store.get(menuAtom) !== null) {
        if (e.key === "j" || e.key === "ArrowDown") store.set(moveMenuItemAtom, "down");
        else if (e.key === "k" || e.key === "ArrowUp") store.set(moveMenuItemAtom, "up");
        else if (e.key === "Enter") store.set(executeMenuItemAtom);
        else if (e.key === "Escape" || e.key === " ") store.set(menuAtom, null);
        else if (e.key === "d") store.set(requestDeleteAtom, null);
        else if (e.key in ACTION_KEYS)
          store.set(runDirectActionAtom, ACTION_KEYS[e.key as keyof typeof ACTION_KEYS]);
        else return;
        e.preventDefault();
        return;
      }

      if (store.get(focusedTaskIdAtom) === null) {
        if (e.key in NAV_KEYS) {
          e.preventDefault();
          store.set(moveFocusAtom, NAV_KEYS[e.key as keyof typeof NAV_KEYS]);
        }
        return;
      }

      if (e.key in NAV_KEYS) {
        e.preventDefault();
        store.set(moveFocusAtom, NAV_KEYS[e.key as keyof typeof NAV_KEYS]);
      } else if (e.key === " ") {
        // preventDefault also stops Space from scrolling the column.
        e.preventDefault();
        const anchor = focusedCardAnchor(store.get(focusedTaskIdAtom));
        if (anchor) store.set(openMenuAtom, anchor);
      } else if (e.key === "d") {
        e.preventDefault();
        const anchor = focusedCardAnchor(store.get(focusedTaskIdAtom));
        if (anchor) store.set(requestDeleteAtom, anchor);
      } else if (e.key in ACTION_KEYS) {
        e.preventDefault();
        store.set(runDirectActionAtom, ACTION_KEYS[e.key as keyof typeof ACTION_KEYS]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        store.set(exitNavAtom);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  // Depends on the position scalars, not the object: the derived atom returns a
  // fresh object on every 3s poll and would otherwise re-focus continuously.
  useEffect(() => {
    if (focusedTaskId === null) return;
    const el = focusedCardElement(focusedTaskId);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedTaskId, position?.colIdx, position?.rowIdx]);

  const focusLost = focusedTaskId !== null && position === null;
  useEffect(() => {
    if (focusLost) store.set(reconcileFocusAtom);
  }, [focusLost, store]);

  useEffect(() => () => store.set(exitNavAtom), [store]);
}
