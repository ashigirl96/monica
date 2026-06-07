import { atom } from "jotai";
import {
  ptyKill,
  terminalLoadState,
  terminalSaveState,
  type TerminalStateSnapshot,
} from "@/commands/pty";
import { markSessionDead } from "@/spaces/work-bench/use-terminal";

const FONT_SIZE_DEFAULT = 13;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;

export const terminalFontSizeAtom = atom(FONT_SIZE_DEFAULT);

export const zoomTerminalAtom = atom(null, (get, set, delta: 1 | -1) => {
  const current = get(terminalFontSizeAtom);
  set(terminalFontSizeAtom, Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, current + delta)));
});

export const resetTerminalZoomAtom = atom(null, (_get, set) => {
  set(terminalFontSizeAtom, FONT_SIZE_DEFAULT);
});

export type TerminalTab = {
  id: string;
  title: string;
  cwd: string;
  order: number;
};

export type TerminalWorkspace = {
  id: string;
  tabs: TerminalTab[];
  activeTabId: string;
  order: number;
};

export type TerminalState = {
  workspaces: TerminalWorkspace[];
  activeWorkspaceId: string;
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

function createTab(cwd: string, order: number): TerminalTab {
  const id = crypto.randomUUID();
  return { id, title: "", cwd, order };
}

function createWorkspace(order: number, cwd?: string): TerminalWorkspace {
  const id = crypto.randomUUID();
  const tab = createTab(cwd ?? defaultCwd(), 0);
  return { id, tabs: [tab], activeTabId: tab.id, order };
}

function extractShortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] ?? path;
}

function deriveWorkspaceTitle(ws: TerminalWorkspace): string {
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId) ?? ws.tabs[0];
  if (!tab) return "";
  const path = tab.cwd !== "~" ? tab.cwd : tab.title || tab.cwd;
  return extractShortPath(path);
}

function deriveWorkspaceDescription(ws: TerminalWorkspace): string {
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId) ?? ws.tabs[0];
  return tab?.title ?? "";
}

function initialState(): TerminalState {
  const ws = createWorkspace(0);
  return { workspaces: [ws], activeWorkspaceId: ws.id };
}

export const terminalStateAtom = atom<TerminalState | null>(null);

export const terminalReadyAtom = atom((get) => get(terminalStateAtom) !== null);

const resolvedStateAtom = atom((get) => get(terminalStateAtom) ?? initialState());

export const activeWorkspaceAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return state.workspaces.find((ws) => ws.id === state.activeWorkspaceId) ?? state.workspaces[0];
});

export const activeTerminalTabAtom = atom((get) => {
  const ws = get(activeWorkspaceAtom);
  if (!ws) return null;
  return ws.tabs.find((t) => t.id === ws.activeTabId) ?? ws.tabs[0] ?? null;
});

export const workspaceSummariesAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return state.workspaces
    .sort((a, b) => a.order - b.order)
    .map((ws) => ({
      id: ws.id,
      title: deriveWorkspaceTitle(ws),
      description: deriveWorkspaceDescription(ws),
      tabCount: ws.tabs.length,
      isActive: ws.id === state.activeWorkspaceId,
    }));
});

export const createWorkspaceAtom = atom(null, (get, set) => {
  const state = get(resolvedStateAtom);
  const activeTab = get(activeTerminalTabAtom);
  const cwd = resolveTabCwd(activeTab);
  const activeWs = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const insertOrder = (activeWs?.order ?? -1) + 1;
  const shifted = state.workspaces.map((w) =>
    w.order >= insertOrder ? { ...w, order: w.order + 1 } : w,
  );
  const ws = createWorkspace(insertOrder, cwd);
  set(terminalStateAtom, {
    workspaces: [...shifted, ws],
    activeWorkspaceId: ws.id,
  });
});

export const removeWorkspaceAtom = atom(null, (get, set, wsId: string) => {
  const state = get(resolvedStateAtom);
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return;

  for (const tab of ws.tabs) {
    markSessionDead(tab.id);
    ptyKill(tab.id);
  }

  const remaining = state.workspaces.filter((w) => w.id !== wsId);
  if (remaining.length === 0) {
    set(terminalStateAtom, initialState());
    return;
  }

  const newActive = state.activeWorkspaceId === wsId ? remaining[0].id : state.activeWorkspaceId;

  set(terminalStateAtom, { workspaces: remaining, activeWorkspaceId: newActive });
});

export const activateWorkspaceAtom = atom(null, (get, set, wsId: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, { ...state, activeWorkspaceId: wsId });
});

export const cycleWorkspaceAtom = atom(null, (get, set, direction: "up" | "down") => {
  const state = get(resolvedStateAtom);
  const sorted = [...state.workspaces].sort((a, b) => a.order - b.order);
  if (sorted.length <= 1) return;

  const idx = sorted.findIndex((ws) => ws.id === state.activeWorkspaceId);
  const newIdx =
    direction === "up" ? (idx - 1 + sorted.length) % sorted.length : (idx + 1) % sorted.length;

  set(terminalStateAtom, { ...state, activeWorkspaceId: sorted[newIdx].id });
});

export const createTerminalTabAtom = atom(null, (get, set) => {
  const state = get(resolvedStateAtom);
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;

  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const cwd = resolveTabCwd(activeTab);
  const insertOrder = (activeTab?.order ?? -1) + 1;
  const shifted = ws.tabs.map((t) => (t.order >= insertOrder ? { ...t, order: t.order + 1 } : t));
  const tab = createTab(cwd, insertOrder);

  const updatedWs: TerminalWorkspace = {
    ...ws,
    tabs: [...shifted, tab],
    activeTabId: tab.id,
  };

  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === ws.id ? updatedWs : w)),
  });
});

export const closeTerminalTabAtom = atom(null, (get, set, tabId?: string) => {
  const state = get(resolvedStateAtom);
  const wsId = tabId
    ? state.workspaces.find((w) => w.tabs.some((t) => t.id === tabId))?.id
    : state.activeWorkspaceId;
  const ws = wsId ? state.workspaces.find((w) => w.id === wsId) : undefined;
  if (!ws) return;

  const targetId = tabId ?? ws.activeTabId;
  if (!ws.tabs.some((t) => t.id === targetId)) return;

  markSessionDead(targetId);
  ptyKill(targetId);

  if (ws.tabs.length <= 1) {
    set(removeWorkspaceAtom, ws.id);
    return;
  }

  const idx = ws.tabs.findIndex((t) => t.id === targetId);
  const newTabs = ws.tabs.filter((t) => t.id !== targetId);
  const newActiveId =
    targetId === ws.activeTabId ? newTabs[Math.min(idx, newTabs.length - 1)].id : ws.activeTabId;

  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === ws.id ? { ...ws, tabs: newTabs, activeTabId: newActiveId } : w,
    ),
  });
});

export const activateTerminalTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(resolvedStateAtom);
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;

  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...ws, activeTabId: tabId } : w)),
  });
});

export const cycleTerminalTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  const state = get(resolvedStateAtom);
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws || ws.tabs.length <= 1) return;

  const sorted = [...ws.tabs].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((t) => t.id === ws.activeTabId);
  const newIdx =
    direction === "left" ? (idx - 1 + sorted.length) % sorted.length : (idx + 1) % sorted.length;

  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === ws.id ? { ...ws, activeTabId: sorted[newIdx].id } : w,
    ),
  });
});

export const updateTabTitleAtom = atom(null, (get, set, tabId: string, title: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
    })),
  });
});

export const updateTabCwdAtom = atom(null, (get, set, tabId: string, cwd: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, cwd } : t)),
    })),
  });
});

export const reorderWorkspacesAtom = atom(null, (get, set, fromId: string, toId: string) => {
  const state = get(resolvedStateAtom);
  const sorted = [...state.workspaces].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((ws) => ws.id === fromId);
  const toIdx = sorted.findIndex((ws) => ws.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;

  const [moved] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, moved);

  set(terminalStateAtom, {
    ...state,
    workspaces: sorted.map((ws, i) => ({ ...ws, order: i })),
  });
});

export const reorderTabsAtom = atom(null, (get, set, fromId: string, toId: string) => {
  const state = get(resolvedStateAtom);
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;

  const sorted = [...ws.tabs].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((t) => t.id === fromId);
  const toIdx = sorted.findIndex((t) => t.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;

  const [moved] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, moved);

  set(terminalStateAtom, {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === ws.id ? { ...ws, tabs: sorted.map((t, i) => ({ ...t, order: i })) } : w,
    ),
  });
});

function stateToSnapshot(state: TerminalState): TerminalStateSnapshot {
  return {
    workspaces: state.workspaces.map((ws) => ({
      id: ws.id,
      sort_order: ws.order,
      is_active: ws.id === state.activeWorkspaceId,
      tabs: ws.tabs.map((t) => ({
        id: t.id,
        cwd: t.cwd !== "~" ? t.cwd : t.title || t.cwd,
        title: t.title,
        sort_order: t.order,
        is_active: t.id === ws.activeTabId,
      })),
    })),
  };
}

function snapshotToState(snap: TerminalStateSnapshot): TerminalState | null {
  if (snap.workspaces.length === 0) return null;
  const workspaces: TerminalWorkspace[] = snap.workspaces.map((ws) => ({
    id: ws.id,
    order: ws.sort_order,
    activeTabId: ws.tabs.find((t) => t.is_active)?.id ?? ws.tabs[0]?.id ?? "",
    tabs: ws.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      order: t.sort_order,
    })),
  }));
  const activeWs = snap.workspaces.find((ws) => ws.is_active);
  return {
    workspaces: workspaces.filter((ws) => ws.tabs.length > 0),
    activeWorkspaceId: activeWs?.id ?? workspaces[0]?.id ?? "",
  };
}

export const loadTerminalStateAtom = atom(null, async (_get, set) => {
  try {
    const snap = await terminalLoadState();
    const state = snapshotToState(snap);
    if (state && state.workspaces.length > 0) {
      set(terminalStateAtom, state);
      return;
    }
  } catch {
    // first launch or empty DB
  }
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
