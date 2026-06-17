import { atom, type Getter } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import type { ProjectEntry, TaskSummaryRow } from "@/commands/task";
import {
  columnTasksAtom,
  taskSummariesAtom,
  selectedProjectAtom,
  closeTaskAtom,
  prepareTaskMutationAtom,
  runTaskAtom,
  openBenchAtom,
} from "@/stores/workboard";
import { queryKeys } from "@/stores/query-keys";
import { pendingWorkboardHintAtom, resolveWorkboardSelection } from "@/stores/ui-state";

type MoveDirection = "up" | "down" | "left" | "right";
type MenuItemId = "prepare" | "run" | "bench" | "close";

export type MenuAnchor = { top: number; left: number; bottom: number };

export type MenuState = {
  taskId: string;
  anchor: MenuAnchor;
  itemIndex: number;
  confirmingClose: boolean;
};

// null = navigation inactive. The board unmounts on space switch, so the last
// position survives in focusMemoryAtom instead and is restored on re-entry.
export const focusedTaskIdAtom = atom<string | null>(null);
export const focusMemoryAtom = atom<string | null>(null);

export const menuAtom = atom<MenuState | null>(null);

export const MENU_ITEMS: ReadonlyArray<{ id: MenuItemId; label: string; hint: string }> = [
  { id: "prepare", label: "Prepare", hint: "p" },
  { id: "run", label: "Run", hint: "r" },
  { id: "bench", label: "Bench", hint: "b" },
  { id: "close", label: "Close", hint: "c" },
];

const CLOSE_INDEX = MENU_ITEMS.findIndex((item) => item.id === "close");

export function isItemDisabled(id: MenuItemId, task: TaskSummaryRow): boolean {
  if (id === "prepare") return !task.prepare_eligible;
  if (id === "run") return !task.run_eligible;
  return false;
}

function taskById(get: Getter, id: string) {
  return get(taskSummariesAtom).find((t) => t.id === id);
}

export const focusedPositionAtom = atom((get) => {
  const id = get(focusedTaskIdAtom);
  if (id === null) return null;
  const columns = get(columnTasksAtom);
  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const rowIdx = columns[colIdx].tasks.findIndex((t) => t.id === id);
    if (rowIdx !== -1) return { colIdx, rowIdx };
  }
  return null;
});

export const moveFocusAtom = atom(null, (get, set, dir: MoveDirection) => {
  const columns = get(columnTasksAtom);
  const focused = get(focusedTaskIdAtom);

  if (focused === null) {
    // The first navigation key only enters the board; the direction is consumed.
    const memory = get(focusMemoryAtom);
    if (memory !== null && columns.some((col) => col.tasks.some((t) => t.id === memory))) {
      set(focusedTaskIdAtom, memory);
      return;
    }
    const first = columns.find((col) => col.tasks.length > 0);
    if (first) set(focusedTaskIdAtom, first.tasks[0].id);
    return;
  }

  const pos = get(focusedPositionAtom);
  if (pos === null) return;

  if (dir === "up" || dir === "down") {
    const tasks = columns[pos.colIdx].tasks;
    const next = dir === "up" ? pos.rowIdx - 1 : pos.rowIdx + 1;
    if (next < 0 || next >= tasks.length) return;
    set(focusedTaskIdAtom, tasks[next].id);
    return;
  }

  const step = dir === "left" ? -1 : 1;
  for (let col = pos.colIdx + step; col >= 0 && col < columns.length; col += step) {
    const tasks = columns[col].tasks;
    if (tasks.length > 0) {
      set(focusedTaskIdAtom, tasks[Math.min(pos.rowIdx, tasks.length - 1)].id);
      return;
    }
  }
});

export const exitNavAtom = atom(null, (get, set) => {
  const focused = get(focusedTaskIdAtom);
  if (focused !== null) set(focusMemoryAtom, focused);
  set(focusedTaskIdAtom, null);
  set(menuAtom, null);
});

// One-shot restore of the saved Work Board filter/focus, applied after loadBoard so the
// hint can be validated against the loaded projects/tasks. Lives here (not in workboard.ts)
// to keep the workboard ⇄ workboard-nav import edge one-directional.
export const applyRestoredWorkboardAtom = atom(null, (get, set) => {
  const hint = get(pendingWorkboardHintAtom);
  if (hint === null) return;
  set(pendingWorkboardHintAtom, null);
  // Read the cache loadBoard just warmed, not the derived atoms: ensureQueryData fills the
  // QueryClient synchronously, but the jotai query atoms only catch up on a deferred
  // notifyManager tick, so reading them here would still see the pre-fetch empty default
  // and drop the saved filter/focus.
  const client = get(queryClientAtom);
  const projects = client.getQueryData<ProjectEntry[]>(queryKeys.projects.list()) ?? [];
  const taskIds = (client.getQueryData<TaskSummaryRow[]>(queryKeys.tasks.summary(null)) ?? []).map(
    (t) => t.id,
  );
  const resolved = resolveWorkboardSelection(
    projects.map((p) => p.repo),
    taskIds,
    hint,
  );
  set(selectedProjectAtom, resolved.selectedProject);
  set(focusedTaskIdAtom, resolved.focusedTaskId);
});

// The focused card can disappear under the 3s polling (status change, filter,
// deletion from the CLI). Re-checks before exiting because the caller observes
// stale state from a React effect.
export const reconcileFocusAtom = atom(null, (get, set) => {
  if (get(focusedTaskIdAtom) === null) return;
  if (get(focusedPositionAtom) !== null) return;
  set(exitNavAtom);
});

export const openMenuAtom = atom(null, (get, set, anchor: MenuAnchor) => {
  const focused = get(focusedTaskIdAtom);
  if (focused === null) return;
  const task = taskById(get, focused);
  if (!task) return;
  const itemIndex = MENU_ITEMS.findIndex((item) => !isItemDisabled(item.id, task));
  if (itemIndex === -1) return;
  set(menuAtom, { taskId: focused, anchor, itemIndex, confirmingClose: false });
});

export const moveMenuItemAtom = atom(null, (get, set, dir: "up" | "down") => {
  const menu = get(menuAtom);
  if (menu === null) return;
  const task = taskById(get, menu.taskId);
  if (!task) return;
  const step = dir === "up" ? -1 : 1;
  for (let i = menu.itemIndex + step; i >= 0 && i < MENU_ITEMS.length; i += step) {
    if (!isItemDisabled(MENU_ITEMS[i].id, task)) {
      set(menuAtom, { ...menu, itemIndex: i, confirmingClose: false });
      return;
    }
  }
});

export const setMenuItemIndexAtom = atom(null, (get, set, itemIndex: number) => {
  const menu = get(menuAtom);
  if (menu === null || menu.itemIndex === itemIndex) return;
  const task = taskById(get, menu.taskId);
  if (!task || isItemDisabled(MENU_ITEMS[itemIndex].id, task)) return;
  set(menuAtom, { ...menu, itemIndex, confirmingClose: false });
});

// Shared by the direct keys (p/r/b) and the menu; re-checks eligibility because
// polling can change the status between render and keypress. The prepare mutation
// reports failures through onError; async atoms still bubble to the global toaster.
export const runDirectActionAtom = atom(null, (get, set, id: Exclude<MenuItemId, "close">) => {
  const menu = get(menuAtom);
  const taskId = menu?.taskId ?? get(focusedTaskIdAtom);
  if (taskId === null) return;
  const task = taskById(get, taskId);
  if (!task || isItemDisabled(id, task)) return;
  set(menuAtom, null);
  if (id === "prepare") get(prepareTaskMutationAtom).mutate(taskId);
  else if (id === "run") void set(runTaskAtom, taskId);
  else void set(openBenchAtom, taskId);
});

// Close is two-step everywhere: the first press opens (or re-targets) the menu
// in confirming state, the second press executes. The anchor is only needed when
// the menu is not open yet.
export const requestCloseAtom = atom(null, (get, set, anchor: MenuAnchor | null) => {
  const menu = get(menuAtom);
  if (menu === null) {
    const focused = get(focusedTaskIdAtom);
    if (focused === null || anchor === null || !taskById(get, focused)) return;
    set(menuAtom, { taskId: focused, anchor, itemIndex: CLOSE_INDEX, confirmingClose: true });
    return;
  }
  if (MENU_ITEMS[menu.itemIndex].id === "close" && menu.confirmingClose) {
    set(menuAtom, null);
    void set(closeFocusedTaskAtom, menu.taskId);
  } else {
    set(menuAtom, { ...menu, itemIndex: CLOSE_INDEX, confirmingClose: true });
  }
});

export const executeMenuItemAtom = atom(null, (get, set) => {
  const menu = get(menuAtom);
  if (menu === null) return;
  const item = MENU_ITEMS[menu.itemIndex];
  if (item.id !== "close") {
    set(runDirectActionAtom, item.id);
    return;
  }
  if (!menu.confirmingClose) {
    set(menuAtom, { ...menu, confirmingClose: true });
    return;
  }
  set(menuAtom, null);
  void set(closeFocusedTaskAtom, menu.taskId);
});

const closeFocusedTaskAtom = atom(null, async (get, set, taskId: string) => {
  // The menu only opens on the focused card, so its position is the closed one.
  const pos = get(focusedPositionAtom);

  await set(closeTaskAtom, taskId);

  if (pos !== null) {
    // columnTasksAtom can still include the just-closed card: invalidateQueries refetched
    // the cache, but the derived atom only updates on a deferred notify tick. Drop the
    // closed id so focus lands on the real neighbour instead of the vanishing card.
    const columns = get(columnTasksAtom);
    const focusInColumn = (col: number): boolean => {
      const tasks = (columns[col]?.tasks ?? []).filter((t) => t.id !== taskId);
      if (tasks.length === 0) return false;
      set(focusedTaskIdAtom, tasks[Math.min(pos.rowIdx, tasks.length - 1)].id);
      return true;
    };
    if (focusInColumn(pos.colIdx)) return;
    for (let col = pos.colIdx + 1; col < columns.length; col++) if (focusInColumn(col)) return;
    for (let col = pos.colIdx - 1; col >= 0; col--) if (focusInColumn(col)) return;
  }
  set(exitNavAtom);
});
