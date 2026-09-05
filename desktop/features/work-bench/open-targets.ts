import { openUrl } from "@tauri-apps/plugin-opener";
import { atom, type Getter } from "jotai";
import type { PopoverAnchor } from "@/components/popover-menu";
import { activeRunspaceAtom, terminalFocusRequestAtom } from "@/features/work-bench/store";
import { visibleAnchorForSelector } from "@/lib/anchor";
import { type OpenTarget, openTargets } from "@/lib/github-targets";
import { activeSpaceAtom, sidebarOpenAtom } from "@/stores/space";
import { taskSummariesAtom } from "@/stores/workboard";
import { pushInfoToast } from "@/stores/toast";

export type OpenTargetMenuState = {
  taskId: string;
  runspaceId: string;
  anchor: PopoverAnchor;
  // The layout the anchor was measured against, so a later ⌘B can be told apart from no change.
  sidebarOpen: boolean;
  selectedUrl: string;
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

// Prefers the sidebar entry so the menu drops from the runspace it describes, falling back to the
// header tab. Neither ⌘B (which clips the sidebar to zero width) nor scrolling the runspace list
// removes a row from the DOM, so both anchors are resolved through the visibility-aware lookup.
const FALLBACK_ANCHOR: PopoverAnchor = { top: 8, bottom: 40, left: 8 };
function menuAnchor(get: Getter): PopoverAnchor {
  const rs = get(activeRunspaceAtom);
  if (!rs) return FALLBACK_ANCHOR;
  return (
    visibleAnchorForSelector(`[data-runspace-id="${CSS.escape(rs.id)}"]`) ??
    (rs.activeTabId
      ? visibleAnchorForSelector(`[data-tab-id="${CSS.escape(rs.activeTabId)}"]`)
      : null) ??
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
  const rs = get(activeRunspaceAtom);
  if (!rs?.taskId) {
    pushInfoToast("This runspace is not bound to a task");
    return;
  }
  const targets = targetsFor(get, rs.taskId);
  if (targets.length === 0) {
    pushInfoToast("No issue or pull request linked to this task");
    return;
  }
  set(openTargetMenuAtom, {
    taskId: rs.taskId,
    runspaceId: rs.id,
    anchor: menuAnchor(get),
    sidebarOpen: get(sidebarOpenAtom),
    selectedUrl: targets[0].url,
  });
});

// The bench keeps running behind the board and the menu is portalled to <body>, so a shortcut
// that leaves this runspace (⌘1, ⌥J) would otherwise strand the menu over another space or
// leave it opening the previous task's links. ⌘B is the same story for the anchor: PopoverMenu
// measures it once and only watches scroll and resize, neither of which a collapse fires.
export const openTargetMenuStaleAtom = atom((get) => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return false;
  if (get(activeSpaceAtom) !== "work-bench") return true;
  if (get(activeRunspaceAtom)?.id !== menu.runspaceId) return true;
  if (get(sidebarOpenAtom) !== menu.sidebarOpen) return true;
  return get(openTargetsAtom).length === 0;
});

// The selection is keyed by URL rather than by row: a poll can drop an issue or a PR while the
// menu is open, and an index would silently slide onto a neighbouring link.
export const openTargetIndexAtom = atom((get) => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return 0;
  const index = get(openTargetsAtom).findIndex((t) => t.url === menu.selectedUrl);
  return index === -1 ? 0 : index;
});

// Stops at both ends, matching the Board's Open submenu.
export const moveOpenTargetAtom = atom(null, (get, set, direction: "up" | "down") => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return;
  const next = get(openTargetsAtom)[get(openTargetIndexAtom) + (direction === "up" ? -1 : 1)];
  if (!next) return;
  set(openTargetMenuAtom, { ...menu, selectedUrl: next.url });
});

export const setOpenTargetIndexAtom = atom(null, (get, set, index: number) => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return;
  const target = get(openTargetsAtom)[index];
  if (!target || target.url === menu.selectedUrl) return;
  set(openTargetMenuAtom, { ...menu, selectedUrl: target.url });
});

export const executeOpenTargetAtom = atom(null, (get, set, index?: number) => {
  const menu = get(openTargetMenuAtom);
  if (menu === null) return;
  const target = get(openTargetsAtom)[index ?? get(openTargetIndexAtom)];
  if (!target) return;
  set(closeOpenTargetMenuAtom);
  void openUrl(target.url);
});
