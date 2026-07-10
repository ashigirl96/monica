import { atom } from "jotai";
import { activeSpaceAtom } from "@/stores/space";
import { focusedTaskIdAtom } from "@/features/work-board/nav";
import { activeRunspaceAtom } from "@/features/work-bench/store";

export const taskMemoAtom = atom<string | null>(null);

// alt+M toggles: close if open, else resolve the target task from the active space
// (board = focused card, bench = the active runspace's task). Returns false when no
// task is in scope so the shortcut can pass through.
export const toggleTaskMemoAtom = atom(null, (get, set): boolean => {
  if (get(taskMemoAtom) !== null) {
    set(taskMemoAtom, null);
    return true;
  }
  const space = get(activeSpaceAtom);
  const taskId =
    space === "work-board"
      ? get(focusedTaskIdAtom)
      : space === "work-bench"
        ? (get(activeRunspaceAtom)?.taskId ?? null)
        : null;
  if (!taskId) return false;
  set(taskMemoAtom, taskId);
  return true;
});
