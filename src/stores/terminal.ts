import { atom } from "jotai";
import {
  ptyKill,
  terminalLoadState,
  terminalSaveState,
  type PtySpawnCommand,
  type TerminalStateSnapshot,
} from "@/commands/pty";
import { markSessionDead } from "@/spaces/work-bench/use-terminal";

const FONT_SIZE_DEFAULT = 15;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;

export const terminalFontSizeAtom = atom(FONT_SIZE_DEFAULT);

export const zoomTerminalAtom = atom(null, (get, set, delta: 1 | -1) => {
  const current = get(terminalFontSizeAtom);
  set(terminalFontSizeAtom, Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, current + delta)));
});

export type TerminalTab = {
  id: string;
  title: string;
  cwd: string;
  order: number;
  launch?: PtySpawnCommand | null;
};

export type TerminalRunspace = {
  id: string;
  kind: "shell" | "task_run";
  taskId?: string | null;
  taskRunId?: string | null;
  taskTitle?: string | null;
  tabs: TerminalTab[];
  activeTabId: string;
  order: number;
};

export type TerminalState = {
  runspaces: TerminalRunspace[];
  activeRunspaceId: string;
};

function defaultCwd(): string {
  return "~";
}

function resolveTabCwd(tab: TerminalTab | null | undefined): string {
  if (!tab) return defaultCwd();
  if (tab.cwd !== "~" && tab.cwd !== "") return tab.cwd;
  if (tab.title && (tab.title.startsWith("/") || tab.title.startsWith("~"))) return tab.title;
  return defaultCwd();
}

function createTab(
  cwd: string,
  order: number,
  title = "",
  launch?: PtySpawnCommand | null,
): TerminalTab {
  const id = crypto.randomUUID();
  return { id, title, cwd, order, launch };
}

function createRunspace(order: number, cwd?: string): TerminalRunspace {
  const id = crypto.randomUUID();
  const tab = createTab(cwd ?? defaultCwd(), 0);
  return { id, kind: "shell", tabs: [tab], activeTabId: tab.id, order };
}

function extractShortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] ?? path;
}

function deriveRunspaceTitle(rs: TerminalRunspace): string {
  if (rs.kind === "task_run" && rs.taskId) return rs.taskId;
  const tab = rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0];
  if (!tab) return "";
  const path = tab.cwd !== "~" ? tab.cwd : tab.title || tab.cwd;
  return extractShortPath(path);
}

function deriveRunspaceDescription(rs: TerminalRunspace): string {
  if (rs.kind === "task_run") return rs.taskTitle ?? rs.taskRunId ?? "";
  const tab = rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0];
  return tab?.title ?? "";
}

function initialState(): TerminalState {
  const rs = createRunspace(0);
  return { runspaces: [rs], activeRunspaceId: rs.id };
}

export const terminalStateAtom = atom<TerminalState | null>(null);

export const terminalReadyAtom = atom((get) => get(terminalStateAtom) !== null);

const resolvedStateAtom = atom((get) => get(terminalStateAtom) ?? initialState());

export const activeRunspaceAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return state.runspaces.find((rs) => rs.id === state.activeRunspaceId) ?? state.runspaces[0];
});

export const activeTerminalTabAtom = atom((get) => {
  const rs = get(activeRunspaceAtom);
  if (!rs) return null;
  return rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0] ?? null;
});

export const runspaceSummariesAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return state.runspaces
    .sort((a, b) => a.order - b.order)
    .map((rs) => ({
      id: rs.id,
      title: deriveRunspaceTitle(rs),
      description: deriveRunspaceDescription(rs),
      tabCount: rs.tabs.length,
      kind: rs.kind,
      taskId: rs.taskId,
      taskRunId: rs.taskRunId,
      isActive: rs.id === state.activeRunspaceId,
    }));
});

export const taskRunspaceMapAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return new Map(
    state.runspaces
      .filter((rs) => rs.kind === "task_run" && rs.taskRunId)
      .map((rs) => [rs.taskRunId!, rs]),
  );
});

export type CreateTaskRunspaceInput = {
  taskId: string;
  taskRunId: string;
  taskTitle: string;
  worktreePath: string;
  launch?: PtySpawnCommand | null;
  activate?: boolean;
};

export const createTaskRunspaceAtom = atom(null, (get, set, input: CreateTaskRunspaceInput) => {
  const state = get(resolvedStateAtom);
  const existing = state.runspaces.find((rs) => rs.taskRunId === input.taskRunId);
  if (existing) {
    if (input.activate) {
      set(terminalStateAtom, { ...state, activeRunspaceId: existing.id });
    }
    return existing.id;
  }

  const tab = createTab(input.worktreePath, 0, "Agent", input.launch ?? null);
  const rs: TerminalRunspace = {
    id: crypto.randomUUID(),
    kind: "task_run",
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    taskTitle: input.taskTitle,
    tabs: [tab],
    activeTabId: tab.id,
    order: 0,
  };
  const shifted = state.runspaces.map((r) => ({ ...r, order: r.order + 1 }));
  set(terminalStateAtom, {
    runspaces: [rs, ...shifted],
    activeRunspaceId: input.activate ? rs.id : state.activeRunspaceId,
  });
  return rs.id;
});

export const activateTaskRunspaceAtom = atom(
  null,
  (get, set, input: { taskRunId?: string | null; taskId?: string | null }) => {
    const state = get(resolvedStateAtom);
    const existing = state.runspaces.find(
      (rs) =>
        (input.taskRunId && rs.taskRunId === input.taskRunId) ||
        (input.taskId && rs.taskId === input.taskId),
    );
    if (!existing) return null;
    set(terminalStateAtom, { ...state, activeRunspaceId: existing.id });
    return existing.id;
  },
);

export const createRunspaceAtom = atom(null, (get, set) => {
  const state = get(resolvedStateAtom);
  const activeTab = get(activeTerminalTabAtom);
  const cwd = resolveTabCwd(activeTab);
  const activeRs = state.runspaces.find((r) => r.id === state.activeRunspaceId);
  const insertOrder = (activeRs?.order ?? -1) + 1;
  const shifted = state.runspaces.map((r) =>
    r.order >= insertOrder ? { ...r, order: r.order + 1 } : r,
  );
  const rs = createRunspace(insertOrder, cwd);
  set(terminalStateAtom, {
    runspaces: [...shifted, rs],
    activeRunspaceId: rs.id,
  });
});

export const removeRunspaceAtom = atom(null, (get, set, rsId: string) => {
  const state = get(resolvedStateAtom);
  const rs = state.runspaces.find((r) => r.id === rsId);
  if (!rs) return;

  for (const tab of rs.tabs) {
    markSessionDead(tab.id);
    ptyKill(tab.id);
  }

  const remaining = state.runspaces.filter((r) => r.id !== rsId);
  if (remaining.length === 0) {
    set(terminalStateAtom, initialState());
    return;
  }

  const newActive = state.activeRunspaceId === rsId ? remaining[0].id : state.activeRunspaceId;

  set(terminalStateAtom, { runspaces: remaining, activeRunspaceId: newActive });
});

export const activateRunspaceAtom = atom(null, (get, set, rsId: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, { ...state, activeRunspaceId: rsId });
});

export const cycleRunspaceAtom = atom(null, (get, set, direction: "up" | "down") => {
  const state = get(resolvedStateAtom);
  const sorted = [...state.runspaces].sort((a, b) => a.order - b.order);
  if (sorted.length <= 1) return;

  const idx = sorted.findIndex((rs) => rs.id === state.activeRunspaceId);
  const newIdx =
    direction === "up" ? (idx - 1 + sorted.length) % sorted.length : (idx + 1) % sorted.length;

  set(terminalStateAtom, { ...state, activeRunspaceId: sorted[newIdx].id });
});

export const createTerminalTabAtom = atom(null, (get, set) => {
  const state = get(resolvedStateAtom);
  const rs = state.runspaces.find((r) => r.id === state.activeRunspaceId);
  if (!rs) return;

  const activeTab = rs.tabs.find((t) => t.id === rs.activeTabId);
  const cwd = resolveTabCwd(activeTab);
  const insertOrder = (activeTab?.order ?? -1) + 1;
  const shifted = rs.tabs.map((t) => (t.order >= insertOrder ? { ...t, order: t.order + 1 } : t));
  const tab = createTab(cwd, insertOrder);

  const updatedRs: TerminalRunspace = {
    ...rs,
    tabs: [...shifted, tab],
    activeTabId: tab.id,
  };

  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((r) => (r.id === rs.id ? updatedRs : r)),
  });
});

export const closeTerminalTabAtom = atom(null, (get, set, tabId?: string) => {
  const state = get(resolvedStateAtom);
  const rsId = tabId
    ? state.runspaces.find((r) => r.tabs.some((t) => t.id === tabId))?.id
    : state.activeRunspaceId;
  const rs = rsId ? state.runspaces.find((r) => r.id === rsId) : undefined;
  if (!rs) return;

  const targetId = tabId ?? rs.activeTabId;
  if (!rs.tabs.some((t) => t.id === targetId)) return;

  markSessionDead(targetId);
  ptyKill(targetId);

  if (rs.tabs.length <= 1) {
    set(removeRunspaceAtom, rs.id);
    return;
  }

  const idx = rs.tabs.findIndex((t) => t.id === targetId);
  const newTabs = rs.tabs.filter((t) => t.id !== targetId);
  const newActiveId =
    targetId === rs.activeTabId ? newTabs[Math.min(idx, newTabs.length - 1)].id : rs.activeTabId;

  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((r) =>
      r.id === rs.id ? { ...rs, tabs: newTabs, activeTabId: newActiveId } : r,
    ),
  });
});

export const activateTerminalTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(resolvedStateAtom);
  const rs = state.runspaces.find((r) => r.id === state.activeRunspaceId);
  if (!rs) return;

  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((r) => (r.id === rs.id ? { ...rs, activeTabId: tabId } : r)),
  });
});

export const cycleTerminalTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  const state = get(resolvedStateAtom);
  const rs = state.runspaces.find((r) => r.id === state.activeRunspaceId);
  if (!rs || rs.tabs.length <= 1) return;

  const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((t) => t.id === rs.activeTabId);
  const newIdx =
    direction === "left" ? (idx - 1 + sorted.length) % sorted.length : (idx + 1) % sorted.length;

  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((r) =>
      r.id === rs.id ? { ...rs, activeTabId: sorted[newIdx].id } : r,
    ),
  });
});

export const updateTabTitleAtom = atom(null, (get, set, tabId: string, title: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((rs) => ({
      ...rs,
      tabs: rs.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
    })),
  });
});

export const updateTabCwdAtom = atom(null, (get, set, tabId: string, cwd: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((rs) => ({
      ...rs,
      tabs: rs.tabs.map((t) => (t.id === tabId ? { ...t, cwd } : t)),
    })),
  });
});

export const reorderRunspacesAtom = atom(null, (get, set, fromId: string, toId: string) => {
  const state = get(resolvedStateAtom);
  const sorted = [...state.runspaces].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((rs) => rs.id === fromId);
  const toIdx = sorted.findIndex((rs) => rs.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;

  const [moved] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, moved);

  set(terminalStateAtom, {
    ...state,
    runspaces: sorted.map((rs, i) => ({ ...rs, order: i })),
  });
});

export const reorderTabsAtom = atom(null, (get, set, fromId: string, toId: string) => {
  const state = get(resolvedStateAtom);
  const rs = state.runspaces.find((r) => r.id === state.activeRunspaceId);
  if (!rs) return;

  const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((t) => t.id === fromId);
  const toIdx = sorted.findIndex((t) => t.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;

  const [moved] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, moved);

  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((r) =>
      r.id === rs.id ? { ...rs, tabs: sorted.map((t, i) => ({ ...t, order: i })) } : r,
    ),
  });
});

function stateToSnapshot(state: TerminalState): TerminalStateSnapshot {
  return {
    runspaces: state.runspaces.map((rs) => ({
      id: rs.id,
      kind: rs.kind,
      task_id: rs.taskId ?? null,
      task_run_id: rs.taskRunId ?? null,
      task_title: rs.taskTitle ?? null,
      sort_order: rs.order,
      is_active: rs.id === state.activeRunspaceId,
      tabs: rs.tabs.map((t) => ({
        id: t.id,
        cwd: t.cwd || defaultCwd(),
        title: t.title,
        sort_order: t.order,
        is_active: t.id === rs.activeTabId,
      })),
    })),
  };
}

function snapshotToState(snap: TerminalStateSnapshot): TerminalState | null {
  if (snap.runspaces.length === 0) return null;
  const runspaces: TerminalRunspace[] = snap.runspaces.map((rs) => ({
    id: rs.id,
    kind: rs.kind === "task_run" ? "task_run" : "shell",
    taskId: rs.task_id,
    taskRunId: rs.task_run_id,
    taskTitle: rs.task_title,
    order: rs.sort_order,
    activeTabId: rs.tabs.find((t) => t.is_active)?.id ?? rs.tabs[0]?.id ?? "",
    tabs: rs.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      order: t.sort_order,
      launch: null,
    })),
  }));
  const activeRs = snap.runspaces.find((rs) => rs.is_active);
  return {
    runspaces: runspaces.filter((rs) => rs.tabs.length > 0),
    activeRunspaceId: activeRs?.id ?? runspaces[0]?.id ?? "",
  };
}

export const loadTerminalStateAtom = atom(null, async (get, set) => {
  if (get(terminalStateAtom)) return;
  try {
    const snap = await terminalLoadState();
    if (get(terminalStateAtom)) return;
    const state = snapshotToState(snap);
    if (state && state.runspaces.length > 0) {
      set(terminalStateAtom, state);
      return;
    }
  } catch {
    // first launch or empty DB
  }
  if (get(terminalStateAtom)) return;
  set(terminalStateAtom, initialState());
});

let saveTimer: number | undefined;

export const saveTerminalStateAtom = atom(null, (get) => {
  const current = get(terminalStateAtom);
  if (!current) return;
  if (saveTimer) clearTimeout(saveTimer);
  const snapshot = stateToSnapshot(current);
  saveTimer = window.setTimeout(() => {
    terminalSaveState(snapshot).catch((e) => console.warn("terminal save failed:", e));
  }, 500);
});
