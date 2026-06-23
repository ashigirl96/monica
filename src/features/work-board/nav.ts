import { openUrl } from "@tauri-apps/plugin-opener";
import { atom, type Getter } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import type { Agent } from "@/commands/bindings";
import type { TaskSummaryRow } from "@/commands/task";
import { openTargets } from "@/features/work-board/github-urls";
import { closeTaskAtom, openBenchAtom, runTaskAtom } from "@/features/work-board/store";
import { columnTasksAtom, prepareTaskMutationAtom, taskSummariesAtom } from "@/stores/workboard";
import { queryKeys } from "@/stores/query-keys";
import { pendingWorkboardHintAtom, resolveWorkboardFocus } from "@/stores/ui-state";

const AGENT_TARGETS: ReadonlyArray<{ agent: Agent; label: string; hint: string }> = [
  { agent: "claude", label: "Claude", hint: "c" },
  { agent: "codex", label: "Codex", hint: "x" },
];

type MoveDirection = "up" | "down" | "left" | "right";
type MenuItemId = "prepare" | "run" | "bench" | "open" | "close";

export type MenuAnchor = { top: number; left: number; bottom: number };

export type Submenu = { kind: "open"; index: number } | { kind: "run"; index: number };

export type MenuState = {
  taskId: string;
  anchor: MenuAnchor;
  itemIndex: number;
  confirmingClose: boolean;
  submenu: Submenu | null;
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
  { id: "open", label: "Open", hint: "o" },
  { id: "close", label: "Close", hint: "c" },
];

const CLOSE_INDEX = MENU_ITEMS.findIndex((item) => item.id === "close");
const OPEN_INDEX = MENU_ITEMS.findIndex((item) => item.id === "open");
const RUN_INDEX = MENU_ITEMS.findIndex((item) => item.id === "run");

export function isItemDisabled(id: MenuItemId, task: TaskSummaryRow): boolean {
  if (id === "prepare") return !task.prepare_eligible;
  if (id === "run") return !task.run_eligible;
  if (id === "open") return openTargets(task).length === 0;
  return false;
}

function taskById(get: Getter, id: string) {
  return get(taskSummariesAtom).find((t) => t.id === id);
}

type ColumnTasks = ReadonlyArray<{ tasks: ReadonlyArray<{ id: string }> }>;

export function findNearestTask(
  columns: ColumnTasks,
  colIdx: number,
  rowIdx: number,
  excludeId?: string,
): string | null {
  const raw = columns[colIdx]?.tasks ?? [];
  const tasks = excludeId ? raw.filter((t) => t.id !== excludeId) : raw;
  if (tasks.length === 0) return null;
  return tasks[Math.min(rowIdx, tasks.length - 1)].id;
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
    const id = findNearestTask(columns, col, pos.rowIdx);
    if (id !== null) {
      set(focusedTaskIdAtom, id);
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

// One-shot restore of the saved Work Board focus, applied after loadBoard so the hint can be
// validated against the loaded tasks. Lives here (not in workboard.ts) to keep the workboard
// ⇄ nav import edge one-directional.
export const applyRestoredWorkboardAtom = atom(null, (get, set) => {
  const hint = get(pendingWorkboardHintAtom);
  if (hint === null) return;
  set(pendingWorkboardHintAtom, null);
  // Read the cache loadBoard just warmed, not the derived atoms: ensureQueryData fills the
  // QueryClient synchronously, but the jotai query atoms only catch up on a deferred
  // notifyManager tick, so reading them here would still see the pre-fetch empty default
  // and drop the saved focus.
  const client = get(queryClientAtom);
  const taskIds = (client.getQueryData<TaskSummaryRow[]>(queryKeys.tasks.summary(null)) ?? []).map(
    (t) => t.id,
  );
  set(focusedTaskIdAtom, resolveWorkboardFocus(taskIds, hint).focusedTaskId);
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
  set(menuAtom, {
    taskId: focused,
    anchor,
    itemIndex,
    confirmingClose: false,
    submenu: null,
  });
});

export const moveMenuItemAtom = atom(null, (get, set, dir: "up" | "down") => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu !== null) return;
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
  if (menu === null || menu.submenu !== null || menu.itemIndex === itemIndex) return;
  const task = taskById(get, menu.taskId);
  if (!task || isItemDisabled(MENU_ITEMS[itemIndex].id, task)) return;
  set(menuAtom, { ...menu, itemIndex, confirmingClose: false });
});

// Shared by the direct keys (p/r/b) and the menu; re-checks eligibility because
// polling can change the status between render and keypress. The prepare mutation
// reports failures through onError; async atoms still bubble to the global toaster.
export const runDirectActionAtom = atom(
  null,
  (get, set, id: Exclude<MenuItemId, "close" | "open">) => {
    const menu = get(menuAtom);
    const taskId = menu?.taskId ?? get(focusedTaskIdAtom);
    if (taskId === null) return;
    const task = taskById(get, taskId);
    if (!task || isItemDisabled(id, task)) return;
    if (id === "prepare") {
      set(menuAtom, null);
      get(prepareTaskMutationAtom).mutate(taskId);
    } else if (id === "run") {
      set(navigateSubmenuAtom, { type: "enter", submenu: "run" });
    } else {
      set(menuAtom, null);
      void set(openBenchAtom, taskId);
    }
  },
);

// Close is two-step everywhere: the first press opens (or re-targets) the menu
// in confirming state, the second press executes. The anchor is only needed when
// the menu is not open yet.
export const requestCloseAtom = atom(null, (get, set, anchor: MenuAnchor | null) => {
  const menu = get(menuAtom);
  if (menu === null) {
    const focused = get(focusedTaskIdAtom);
    if (focused === null || anchor === null || !taskById(get, focused)) return;
    set(menuAtom, {
      taskId: focused,
      anchor,
      itemIndex: CLOSE_INDEX,
      confirmingClose: true,
      submenu: null,
    });
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
  // The submenu's Enter routes here too, not through a separate handler — a second Enter
  // path would open two tabs.
  if (menu.submenu?.kind === "open") {
    set(executeOpenAtom);
    return;
  }
  if (menu.submenu?.kind === "run") {
    set(executeRunAtom);
    return;
  }
  const item = MENU_ITEMS[menu.itemIndex];
  if (item.id === "open") {
    set(navigateSubmenuAtom, { type: "enter", submenu: "open" });
    return;
  }
  if (item.id === "run") {
    set(navigateSubmenuAtom, { type: "enter", submenu: "run" });
    return;
  }
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

type SubmenuKind = "open" | "run";

type SubmenuNavAction =
  | { type: "enter"; submenu: SubmenuKind }
  | { type: "exit" }
  | { type: "move"; direction: "up" | "down" }
  | { type: "setIndex"; index: number };

const enterSubmenuAtom = atom(null, (get, set, submenu: SubmenuKind) => {
  if (submenu === "open") {
    const menu = get(menuAtom);
    if (menu === null) return;
    const task = taskById(get, menu.taskId);
    if (!task || openTargets(task).length === 0) return;
    set(menuAtom, {
      ...menu,
      itemIndex: OPEN_INDEX,
      confirmingClose: false,
      submenu: { kind: "open", index: 0 },
    });
  } else {
    const menu = get(menuAtom);
    const taskId = menu?.taskId ?? get(focusedTaskIdAtom);
    if (taskId === null) return;
    const task = taskById(get, taskId);
    if (!task || !task.run_eligible) return;
    if (menu) {
      set(menuAtom, {
        ...menu,
        itemIndex: RUN_INDEX,
        confirmingClose: false,
        submenu: { kind: "run", index: 0 },
      });
    } else {
      const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
      const rect = el?.getBoundingClientRect();
      if (!rect) return;
      set(menuAtom, {
        taskId,
        anchor: { top: rect.top, left: rect.left, bottom: rect.bottom },
        itemIndex: RUN_INDEX,
        confirmingClose: false,
        submenu: { kind: "run", index: 0 },
      });
    }
  }
});

const exitSubmenuAtom = atom(null, (get, set) => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu === null) return;
  set(menuAtom, { ...menu, submenu: null });
});

const moveSubmenuAtom = atom(null, (get, set, direction: "up" | "down") => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu === null) return;
  const next = menu.submenu.index + (direction === "up" ? -1 : 1);
  let maxCount: number;
  if (menu.submenu.kind === "open") {
    const task = taskById(get, menu.taskId);
    if (!task) return;
    maxCount = openTargets(task).length;
  } else {
    maxCount = AGENT_TARGETS.length;
  }
  if (next < 0 || next >= maxCount) return;
  set(menuAtom, { ...menu, submenu: { ...menu.submenu, index: next } });
});

const setSubmenuIndexAtom = atom(null, (get, set, index: number) => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu === null || menu.submenu.index === index) return;
  set(menuAtom, { ...menu, submenu: { ...menu.submenu, index } });
});

export const navigateSubmenuAtom = atom(null, (_get, set, action: SubmenuNavAction) => {
  if (action.type === "enter") set(enterSubmenuAtom, action.submenu);
  else if (action.type === "exit") set(exitSubmenuAtom);
  else if (action.type === "move") set(moveSubmenuAtom, action.direction);
  else set(setSubmenuIndexAtom, action.index);
});

export const requestOpenAtom = atom(null, (get, set, anchor: MenuAnchor | null) => {
  const focused = get(focusedTaskIdAtom);
  if (focused === null || anchor === null) return;
  const task = taskById(get, focused);
  if (!task || openTargets(task).length === 0) return;
  set(menuAtom, {
    taskId: focused,
    anchor,
    itemIndex: OPEN_INDEX,
    confirmingClose: false,
    submenu: { kind: "open", index: 0 },
  });
});

export { AGENT_TARGETS };

export const executeRunAtom = atom(null, (get, set) => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu?.kind !== "run") return;
  const agent = AGENT_TARGETS[menu.submenu.index];
  if (!agent) return;
  const taskId = menu.taskId;
  set(menuAtom, null);
  void set(runTaskAtom, taskId, agent.agent);
});

// Bound to "i" in the submenu (PRs get no single key because a task can have several): jumps
// the cursor to the issue and opens it through the one execute path.
export const openIssueTargetAtom = atom(null, (get, set) => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu?.kind !== "open") return;
  const task = taskById(get, menu.taskId);
  if (!task) return;
  const idx = openTargets(task).findIndex((t) => t.kind === "issue");
  if (idx === -1) return;
  set(menuAtom, { ...menu, submenu: { kind: "open", index: idx } });
  set(executeOpenAtom);
});

const executeOpenAtom = atom(null, (get, set) => {
  const menu = get(menuAtom);
  if (menu === null || menu.submenu?.kind !== "open") return;
  const task = taskById(get, menu.taskId);
  if (!task) return;
  const target = openTargets(task)[menu.submenu.index];
  if (!target) return;
  set(menuAtom, null);
  void openUrl(target.url);
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
    const tryFocus = (col: number): boolean => {
      const id = findNearestTask(columns, col, pos.rowIdx, taskId);
      if (id === null) return false;
      set(focusedTaskIdAtom, id);
      return true;
    };
    if (tryFocus(pos.colIdx)) return;
    for (let col = pos.colIdx + 1; col < columns.length; col++) if (tryFocus(col)) return;
    for (let col = pos.colIdx - 1; col >= 0; col--) if (tryFocus(col)) return;
  }
  set(exitNavAtom);
});
