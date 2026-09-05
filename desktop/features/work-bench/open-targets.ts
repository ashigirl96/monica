import { openUrl } from "@tauri-apps/plugin-opener";
import { atom, type Getter } from "jotai";
import type { PopoverAnchor } from "@/components/popover-menu";
import { activeRunspaceAtom, terminalFocusRequestAtom } from "@/features/work-bench/store";
import { anchorForSelector } from "@/lib/anchor";
import { type OpenTarget, openTargets } from "@/lib/github-targets";
import { taskSummariesAtom } from "@/stores/workboard";
import { pushInfoToast } from "@/stores/toast";

export type OpenTargetMenuState = {
  taskId: string;
  anchor: PopoverAnchor;
  index: number;
};

export const openTargetMenuAtom = atom<OpenTargetMenuState | null>(null);

// The sidebar's projected summary deliberately omits URLs and PRs; the full row is read only
// while the menu is open, so the projection keeps its re-render economy.
function targetsFor(get: Getter, taskId: string): OpenTarget[] {
  const task = get(taskSummariesAtom).find((t) => t.id === taskId);
  return task ? openTargets(task) : [];
}

const NO_TARGETS: OpenTarget[] = [];
export const openTargetsAtom = atom((get) => {
  const menu = get(openTargetMenuAtom);
  return menu ? targetsFor(get, menu.taskId) : NO_TARGETS;
});

// Prefers the sidebar entry so the menu drops from the runspace it describes; with the sidebar
// collapsed (⌘B) the header tab is the only visible element that stands for the runspace.
const FALLBACK_ANCHOR: PopoverAnchor = { top: 8, bottom: 40, left: 8 };
function menuAnchor(get: Getter): PopoverAnchor {
  const rs = get(activeRunspaceAtom);
  if (!rs) return FALLBACK_ANCHOR;
  return (
    anchorForSelector(`[data-runspace-id="${CSS.escape(rs.id)}"]`) ??
    (rs.activeTabId ? anchorForSelector(`[data-tab-id="${CSS.escape(rs.activeTabId)}"]`) : null) ??
    FALLBACK_ANCHOR
  );
}

export const closeOpenTargetMenuAtom = atom(null, (get, set) => {
  if (get(openTargetMenuAtom) === null) return;
  set(openTargetMenuAtom, null);
  set(terminalFocusRequestAtom, (c) => c + 1);
});

export const toggleOpenTargetMenuAtom = atom(null, (get, set) => {
  if (get(openTargetMenuAtom) !== null) {
    set(closeOpenTargetMenuAtom);
    return;
  }
  const taskId = get(activeRunspaceAtom)?.taskId;
  if (!taskId) {
    pushInfoToast("This runspace is not bound to a task");
    return;
  }
  if (targetsFor(get, taskId).length === 0) {
    pushInfoToast("No issue or pull request linked to this task");
    return;
  }
  set(openTargetMenuAtom, { taskId, anchor: menuAnchor(get), index: 0 });
});

// Stops at both ends, matching the Board's Open submenu.
export const moveOpenTargetAtom = atom(null, (get, set, direction: "up" | "down") => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return;
  const next = menu.index + (direction === "up" ? -1 : 1);
  if (next < 0 || next >= get(openTargetsAtom).length) return;
  set(openTargetMenuAtom, { ...menu, index: next });
});

export const setOpenTargetIndexAtom = atom(null, (get, set, index: number) => {
  const menu = get(openTargetMenuAtom);
  if (menu === null || menu.index === index) return;
  set(openTargetMenuAtom, { ...menu, index });
});

export const executeOpenTargetAtom = atom(null, (get, set, index?: number) => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return;
  const target = get(openTargetsAtom)[index ?? menu.index];
  if (!target) return;
  set(closeOpenTargetMenuAtom);
  void openUrl(target.url);
});
