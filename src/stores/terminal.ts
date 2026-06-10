import { atom } from "jotai";
import {
  ptyKill,
  terminalLoadState,
  terminalSaveState,
  type TerminalStateSnapshot,
} from "@/commands/pty";
import { listBenchRunspaceMap, primaryTabId, taskShellEnv } from "@/commands/task";
import { worktreeInfo, type WorktreeInfo } from "@/commands/git";
import { markSessionDead } from "@/spaces/work-bench/use-terminal";

const FONT_SIZE_DEFAULT = 15;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;

export const terminalFontSizeAtom = atom(FONT_SIZE_DEFAULT);

export const terminalFocusRequestAtom = atom(0);

export const zoomTerminalAtom = atom(null, (get, set, delta: 1 | -1) => {
  const current = get(terminalFontSizeAtom);
  set(terminalFontSizeAtom, Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, current + delta)));
});

export type TerminalLaunchIntent = {
  env: [string, string][];
  initialCommand: string;
};

export type TerminalTab = {
  id: string;
  title: string;
  cwd: string;
  order: number;
  launch?: TerminalLaunchIntent;
};

export type TerminalRunspace = {
  id: string;
  taskId?: string;
  env?: [string, string][];
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

function createTab(cwd: string, order: number): TerminalTab {
  const id = crypto.randomUUID();
  return { id, title: "", cwd, order };
}

function createRunspace(order: number, cwd?: string): TerminalRunspace {
  const id = crypto.randomUUID();
  const tab = createTab(cwd ?? defaultCwd(), 0);
  return { id, tabs: [tab], activeTabId: tab.id, order };
}

function extractShortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] ?? path;
}

function tabDisplayPath(tab: TerminalTab): string {
  return tab.cwd !== "~" ? tab.cwd : tab.title || tab.cwd;
}

function deriveRunspaceTitle(
  rs: TerminalRunspace,
  worktrees: Record<string, WorktreeInfo | null>,
): string {
  const tab = rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0];
  if (!tab) return "";
  const path = tabDisplayPath(tab);
  const worktree = worktrees[path];
  if (worktree) return `${worktree.repo}:${worktree.branch}`;
  return extractShortPath(path);
}

function deriveRunspaceDescription(rs: TerminalRunspace): string {
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

// path → linked-worktree identity (null = not a worktree). The branch can change
// without a cwd change (`git switch` in place), so title updates re-resolve known
// paths instead of trusting the cache forever; the timestamp map throttles that
// against apps that rewrite the terminal title continuously.
const worktreeInfoByPathAtom = atom<Record<string, WorktreeInfo | null>>({});

const WORKTREE_REVALIDATE_MS = 5000;
const worktreeResolvedAt: Record<string, number> = {};

const resolveWorktreeInfoAtom = atom(null, async (get, set, revalidate?: string[]) => {
  const state = get(terminalStateAtom);
  if (!state) return;
  const cache = get(worktreeInfoByPathAtom);
  const now = Date.now();

  const paths = new Set<string>();
  for (const path of revalidate ?? []) {
    if (path.startsWith("/") && now - (worktreeResolvedAt[path] ?? 0) >= WORKTREE_REVALIDATE_MS) {
      paths.add(path);
    }
  }
  for (const rs of state.runspaces) {
    for (const tab of rs.tabs) {
      const path = tabDisplayPath(tab);
      if (path.startsWith("/") && !(path in cache)) paths.add(path);
    }
  }
  if (paths.size === 0) return;
  for (const path of paths) worktreeResolvedAt[path] = now;

  const entries = await Promise.all(
    [...paths].map(async (path) => [path, await worktreeInfo(path).catch(() => null)] as const),
  );
  set(worktreeInfoByPathAtom, (prev) => {
    const next = { ...prev };
    for (const [path, info] of entries) next[path] = info;
    return next;
  });
});

// taskId → tab hosting the task's Main Run. Hook-driven claims write straight to the
// DB without a Tauri event, so this is refreshed by polling alongside the summaries.
export const primaryTabByTaskAtom = atom<Record<string, string | null>>({});

export const refreshPrimaryTabAtom = atom(null, async (get, set) => {
  const rs = get(activeRunspaceAtom);
  const taskId = rs?.taskId;
  if (!taskId) return;
  const tabId = await primaryTabId(taskId);
  set(primaryTabByTaskAtom, (prev) =>
    prev[taskId] === tabId ? prev : { ...prev, [taskId]: tabId },
  );
});

export type RunspaceSummary = {
  id: string;
  taskId: string | undefined;
  title: string;
  description: string;
  tabCount: number;
  isActive: boolean;
};

export const runspaceSummariesAtom = atom<RunspaceSummary[]>((get) => {
  const state = get(resolvedStateAtom);
  const worktrees = get(worktreeInfoByPathAtom);
  return state.runspaces
    .sort((a, b) => a.order - b.order)
    .map((rs) => ({
      id: rs.id,
      taskId: rs.taskId,
      title: deriveRunspaceTitle(rs, worktrees),
      description: deriveRunspaceDescription(rs),
      tabCount: rs.tabs.length,
      isActive: rs.id === state.activeRunspaceId,
    }));
});

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
  set(terminalFocusRequestAtom, (c) => c + 1);
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
  set(terminalFocusRequestAtom, (c) => c + 1);
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
  // Shells retitle on every prompt, making this the signal that something may have
  // run in the tab — including a branch switch the cwd watcher cannot see.
  const tab = state.runspaces.flatMap((rs) => rs.tabs).find((t) => t.id === tabId);
  if (tab) void set(resolveWorktreeInfoAtom, [tabDisplayPath({ ...tab, title })]);
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
  void set(resolveWorktreeInfoAtom, [cwd]);
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
      sort_order: rs.order,
      is_active: rs.id === state.activeRunspaceId,
      tabs: rs.tabs.map((t) => ({
        id: t.id,
        cwd: tabDisplayPath(t),
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
    order: rs.sort_order,
    activeTabId: rs.tabs.find((t) => t.is_active)?.id ?? rs.tabs[0]?.id ?? "",
    tabs: rs.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      order: t.sort_order,
    })),
  }));
  const activeRs = snap.runspaces.find((rs) => rs.is_active);
  return {
    runspaces: runspaces.filter((rs) => rs.tabs.length > 0),
    activeRunspaceId: activeRs?.id ?? runspaces[0]?.id ?? "",
  };
}

// Concurrent loads (e.g. WorkBench mount racing createTaskRunspaceAtom) must share
// one promise: the null check alone lets the slower load overwrite state mutated in
// between, dropping freshly created tabs.
let loadTerminalStateInFlight: Promise<void> | null = null;

export const loadTerminalStateAtom = atom(null, (get, set): Promise<void> => {
  if (get(terminalStateAtom) !== null) return Promise.resolve();
  if (loadTerminalStateInFlight) return loadTerminalStateInFlight;

  loadTerminalStateInFlight = (async () => {
    try {
      const [snap, benchMap] = await Promise.all([terminalLoadState(), listBenchRunspaceMap()]);
      const runspaceToTask = new Map(benchMap.map(([rsId, taskId]) => [rsId, taskId]));
      const state = snapshotToState(snap);
      if (state && state.runspaces.length > 0) {
        // Runspace env is never persisted; recompute it from the task so tabs
        // restored after a restart still get the Monica context + claude wrapper.
        const taskIds = [
          ...new Set(
            state.runspaces.map((rs) => runspaceToTask.get(rs.id)).filter((t): t is string => !!t),
          ),
        ];
        const envByTask = new Map(
          await Promise.all(
            taskIds.map(
              async (tid) =>
                [tid, await taskShellEnv(tid).catch(() => [])] as [string, [string, string][]],
            ),
          ),
        );
        state.runspaces = state.runspaces.map((rs) => {
          const taskId = runspaceToTask.get(rs.id);
          const env = taskId ? envByTask.get(taskId) : undefined;
          return { ...rs, taskId, env: env && env.length > 0 ? env : undefined };
        });
        set(terminalStateAtom, state);
        void set(resolveWorktreeInfoAtom);
        return;
      }
    } catch {
      // first launch or empty DB
    }
    set(terminalStateAtom, initialState());
  })().finally(() => {
    loadTerminalStateInFlight = null;
  });

  return loadTerminalStateInFlight;
});

export const createTaskRunspaceAtom = atom(
  null,
  async (
    get,
    set,
    params: {
      runspaceId: string;
      taskId: string;
      cwd: string;
      env?: [string, string][];
      launch?: TerminalLaunchIntent;
    },
  ) => {
    if (get(terminalStateAtom) === null) {
      await set(loadTerminalStateAtom);
    }

    const state = get(resolvedStateAtom);

    const existing = state.runspaces.find((r) => r.id === params.runspaceId);
    if (existing) {
      const base: TerminalRunspace = { ...existing, env: params.env ?? existing.env };

      let updated: TerminalRunspace;
      if (params.launch) {
        const newTab = createTab(params.cwd, existing.tabs.length);
        newTab.launch = params.launch;
        updated = { ...base, tabs: [...existing.tabs, newTab], activeTabId: newTab.id };
      } else if (params.cwd && existing.tabs[0]?.cwd !== params.cwd) {
        updated = { ...base, tabs: existing.tabs.map((t) => ({ ...t, cwd: params.cwd })) };
      } else {
        updated = base;
      }

      set(terminalStateAtom, {
        ...state,
        activeRunspaceId: existing.id,
        runspaces: state.runspaces.map((r) => (r.id === existing.id ? updated : r)),
      });
      void set(resolveWorktreeInfoAtom);
      return;
    }

    const maxOrder = state.runspaces.reduce((m, r) => Math.max(m, r.order), -1);
    const tab = createTab(params.cwd, 0);
    if (params.launch) {
      tab.launch = params.launch;
    }
    const rs: TerminalRunspace = {
      id: params.runspaceId,
      taskId: params.taskId,
      env: params.env,
      tabs: [tab],
      activeTabId: tab.id,
      order: maxOrder + 1,
    };
    set(terminalStateAtom, {
      runspaces: [...state.runspaces, rs],
      activeRunspaceId: rs.id,
    });
    void set(resolveWorktreeInfoAtom);
  },
);

export const consumeTerminalLaunchAtom = atom(null, (get, set, tabId: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, {
    ...state,
    runspaces: state.runspaces.map((rs) => ({
      ...rs,
      tabs: rs.tabs.map((t) => (t.id === tabId ? { ...t, launch: undefined } : t)),
    })),
  });
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
