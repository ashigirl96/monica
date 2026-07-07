import { shortPath } from "@/lib/paths";
import { atom, type Getter, type Setter } from "jotai";
import {
  terminalDetach,
  terminalListSessions,
  terminalLoadState,
  terminalSaveState,
  terminalTerminate,
  type TerminalRunspaceKind,
  type TerminalSession,
  type TerminalSessionStatus,
  type TerminalStateSnapshot,
} from "@/commands/terminal";
import { listBenchRunspaceMap, makeMainTaskRun, primaryTabId, taskShellEnv } from "@/commands/task";
import { readRunspacePlan, type PlanPreview } from "@/commands/plan";
import { worktreeInfo, type WorktreeInfo } from "@/commands/git";
import { releaseTabConnection } from "@/features/work-bench/terminal-connections";
import {
  MAIN_WINDOW_LABEL,
  type WorkbenchHint,
  pendingWorkbenchHintAtom,
  resolveWorkbenchActive,
  windowLabelAtom,
} from "@/stores/ui-state";
import { refreshTaskSummariesAtom } from "@/stores/workboard";

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
  /// The durable TerminalSession this tab is attached to. Tab identity (UI) and session
  /// identity (process) are separate: closing the tab detaches, never kills.
  sessionId?: string;
  launch?: TerminalLaunchIntent;
};

export type TerminalRunspace = {
  id: string;
  /// Rust-derived classification (load / adopt stamp it); absence means standard.
  kind?: TerminalRunspaceKind;
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

export function isAgentRuntimeRunspace(rs: { kind?: TerminalRunspaceKind }): boolean {
  return rs.kind === "agent_runtime";
}

function defaultCwd(): string {
  return "~";
}

function resolveTabCwd(tab: TerminalTab | null | undefined): string {
  if (!tab) return defaultCwd();
  if (tab.cwd !== "~" && tab.cwd !== "") return tab.cwd;
  if (tab.title && (tab.title.startsWith("/") || tab.title.startsWith("~"))) return tab.title;
  return defaultCwd();
}

function patchTabInState(
  state: TerminalState,
  tabId: string,
  patch: Partial<TerminalTab>,
): TerminalState {
  return {
    ...state,
    runspaces: state.runspaces.map((rs) => ({
      ...rs,
      tabs: rs.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    })),
  };
}

function patchRunspaceInState(
  state: TerminalState,
  rsId: string,
  patch: Partial<TerminalRunspace>,
): TerminalState {
  return {
    ...state,
    runspaces: state.runspaces.map((r) => (r.id === rsId ? { ...r, ...patch } : r)),
  };
}

function updateActiveRunspace(
  get: Getter,
  set: Setter,
  updater: (rs: TerminalRunspace) => Partial<TerminalRunspace> | null,
): boolean {
  const state = get(resolvedStateAtom);
  const rs = state.runspaces.find((r) => r.id === state.activeRunspaceId);
  if (!rs) return false;
  const patch = updater(rs);
  if (!patch) return false;
  set(terminalStateAtom, patchRunspaceInState(state, rs.id, patch));
  return true;
}

function reorderByOrder<T extends { id: string; order: number }>(
  items: T[],
  fromId: string,
  toId: string,
): T[] | null {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((it) => it.id === fromId);
  const toIdx = sorted.findIndex((it) => it.id === toId);
  if (fromIdx === -1 || toIdx === -1) return null;
  const [moved] = sorted.splice(fromIdx, 1);
  sorted.splice(toIdx, 0, moved);
  return sorted.map((it, i) => ({ ...it, order: i }));
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
  return shortPath(path);
}

function deriveRunspaceDescription(rs: TerminalRunspace): string {
  const tab = rs.tabs.find((t) => t.id === rs.activeTabId) ?? rs.tabs[0];
  return tab?.title ?? "";
}

function initialState(): TerminalState {
  const rs = createRunspace(0);
  return { runspaces: [rs], activeRunspaceId: rs.id };
}

const baseTerminalStateAtom = atom<TerminalState | null>(null);

// Every runspace/tab switch routes through this setter, so hint dismissal and the
// Alt+O last-runspace memory live here instead of being repeated in each action atom.
export const terminalStateAtom = atom(
  (get) => get(baseTerminalStateAtom),
  (get, set, next: TerminalState) => {
    const prev = get(baseTerminalStateAtom);
    set(baseTerminalStateAtom, next);
    if (!prev) return;

    const activeTabId = (s: TerminalState) =>
      s.runspaces.find((r) => r.id === s.activeRunspaceId)?.activeTabId;
    if (
      prev.activeRunspaceId !== next.activeRunspaceId ||
      activeTabId(prev) !== activeTabId(next)
    ) {
      set(jumpHintsActiveAtom, false);
    }
    if (
      prev.activeRunspaceId !== next.activeRunspaceId &&
      next.runspaces.some((r) => r.id === prev.activeRunspaceId)
    ) {
      set(lastRunspaceIdAtom, prev.activeRunspaceId);
    }
  },
);

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
const worktreeResolvedAtAtom = atom<Record<string, number>>({});

const resolveWorktreeInfoAtom = atom(null, async (get, set, revalidate?: string[]) => {
  const state = get(terminalStateAtom);
  if (!state) return;
  const cache = get(worktreeInfoByPathAtom);
  const resolvedAt = get(worktreeResolvedAtAtom);
  const now = Date.now();

  const paths = new Set<string>();
  for (const path of revalidate ?? []) {
    if (path.startsWith("/") && now - (resolvedAt[path] ?? 0) >= WORKTREE_REVALIDATE_MS) {
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
  set(worktreeResolvedAtAtom, (prev) => {
    const next = { ...prev };
    for (const path of paths) next[path] = now;
    return next;
  });

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

// cmd+g: promote the run living in the focused tab to Main Run. Backend returns
// false for both "no run in this tab" and "already main", keeping this a silent no-op.
export const promoteActiveTabRunAtom = atom(null, async (get, set) => {
  const tab = get(activeTerminalTabAtom);
  if (!tab) return;
  const changed = await makeMainTaskRun(tab.id);
  if (changed) {
    await Promise.all([set(refreshTaskSummariesAtom), set(refreshPrimaryTabAtom)]);
  }
});

// Quick Look-style plan preview: null when closed, the resolved plan when open.
export const planPreviewAtom = atom<PlanPreview | null>(null);

// cmd+E toggles: close if open, else read the active tab's run plan and open it. A shell tab or a
// run with no plan (or a deleted file) resolves to null and the overlay stays shut.
export const togglePlanPreviewAtom = atom(null, async (get, set) => {
  if (get(planPreviewAtom)) {
    set(planPreviewAtom, null);
    return;
  }
  const tab = get(activeTerminalTabAtom);
  if (!tab) return;
  const plan = await readRunspacePlan(tab.id);
  if (plan) set(planPreviewAtom, plan);
});

export type RunspaceSummary = {
  id: string;
  kind: TerminalRunspaceKind | undefined;
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
      kind: rs.kind,
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

// Closing a tab or runspace detaches the session (the process keeps running under the
// daemon and shows up in the Detached group); only an explicit terminate kills it.
export function detachTab(tab: TerminalTab): Promise<void> {
  const sessionId = releaseTabConnection(tab.id) ?? tab.sessionId;
  if (!sessionId) return Promise.resolve();
  return terminalDetach(sessionId).catch((e: unknown) =>
    console.warn("terminal detach failed:", e),
  );
}

export async function terminateTab(tab: TerminalTab): Promise<void> {
  const sessionId = releaseTabConnection(tab.id) ?? tab.sessionId;
  if (!sessionId) return;
  try {
    await terminalTerminate(sessionId);
  } catch (e) {
    console.warn("terminal terminate failed:", e);
  }
}

export const removeRunspaceAtom = atom(
  null,
  (get, set, rsId: string, mode: "detach" | "terminate" = "detach") => {
    const state = get(resolvedStateAtom);
    const rs = state.runspaces.find((r) => r.id === rsId);
    if (!rs) return;

    if (mode === "terminate") {
      // A detach racing the Exit broadcast would transiently mark the session Detached
      // in the DB, and the sidebar poll would surface it as a zombie until the exit lands.
      void Promise.allSettled(rs.tabs.map(terminateTab)).then(() => set(refreshSessionsAtom));
    } else {
      for (const tab of rs.tabs) {
        detachTab(tab);
      }
    }

    const remaining = state.runspaces.filter((r) => r.id !== rsId);
    if (remaining.length === 0) {
      set(terminalStateAtom, initialState());
      return;
    }

    const newActive = state.activeRunspaceId === rsId ? remaining[0].id : state.activeRunspaceId;

    set(terminalStateAtom, { runspaces: remaining, activeRunspaceId: newActive });
  },
);

export const lastRunspaceIdAtom = atom<string | null>(null);

export const activateRunspaceAtom = atom(null, (get, set, rsId: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, { ...state, activeRunspaceId: rsId });
  set(terminalFocusRequestAtom, (c) => c + 1);
});

export const toggleLastRunspaceAtom = atom(null, (get, set) => {
  const state = get(resolvedStateAtom);
  const lastId = get(lastRunspaceIdAtom);
  if (!lastId || lastId === state.activeRunspaceId) return;
  if (!state.runspaces.some((r) => r.id === lastId)) return;
  set(activateRunspaceAtom, lastId);
});

// Agent Runtime runspaces are mouse-only: they never take part in cycling, and cycling
// out of one escapes into the normal set instead of wrapping through it.
export const cycleRunspaceAtom = atom(null, (get, set, direction: "up" | "down") => {
  const state = get(resolvedStateAtom);
  const sorted = state.runspaces
    .filter((rs) => !isAgentRuntimeRunspace(rs))
    .sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return;

  const idx = sorted.findIndex((rs) => rs.id === state.activeRunspaceId);
  if (idx === -1) {
    set(terminalStateAtom, {
      ...state,
      activeRunspaceId: sorted[direction === "down" ? 0 : sorted.length - 1].id,
    });
    return;
  }
  if (sorted.length === 1) return;
  const newIdx =
    direction === "up" ? (idx - 1 + sorted.length) % sorted.length : (idx + 1) % sorted.length;

  set(terminalStateAtom, { ...state, activeRunspaceId: sorted[newIdx].id });
});

export const createTerminalTabAtom = atom(null, (get, set) => {
  updateActiveRunspace(get, set, (rs) => {
    const activeTab = rs.tabs.find((t) => t.id === rs.activeTabId);
    const cwd = resolveTabCwd(activeTab);
    const insertOrder = (activeTab?.order ?? -1) + 1;
    const shifted = rs.tabs.map((t) => (t.order >= insertOrder ? { ...t, order: t.order + 1 } : t));
    const tab = createTab(cwd, insertOrder);
    return { tabs: [...shifted, tab], activeTabId: tab.id };
  });
});

export const closeTerminalTabAtom = atom(null, (get, set, tabId?: string) => {
  const state = get(resolvedStateAtom);
  const isSecondary = get(windowLabelAtom) !== MAIN_WINDOW_LABEL;
  const rsId = tabId
    ? state.runspaces.find((r) => r.tabs.some((t) => t.id === tabId))?.id
    : state.activeRunspaceId;
  const rs = rsId ? state.runspaces.find((r) => r.id === rsId) : undefined;
  if (!rs) return;

  const targetId = tabId ?? rs.activeTabId;
  const target = rs.tabs.find((t) => t.id === targetId);
  if (!target) return;

  if (rs.tabs.length <= 1) {
    set(removeRunspaceAtom, rs.id, isSecondary ? "terminate" : "detach");
    return;
  }

  if (isSecondary) {
    void terminateTab(target);
  } else {
    detachTab(target);
  }

  const idx = rs.tabs.findIndex((t) => t.id === targetId);
  const newTabs = rs.tabs.filter((t) => t.id !== targetId);
  const newActiveId =
    targetId === rs.activeTabId ? newTabs[Math.min(idx, newTabs.length - 1)].id : rs.activeTabId;

  set(
    terminalStateAtom,
    patchRunspaceInState(state, rs.id, { tabs: newTabs, activeTabId: newActiveId }),
  );
});

export const activateTerminalTabAtom = atom(null, (get, set, tabId: string) => {
  if (updateActiveRunspace(get, set, () => ({ activeTabId: tabId }))) {
    set(terminalFocusRequestAtom, (c) => c + 1);
  }
});

export const cycleTerminalTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  updateActiveRunspace(get, set, (rs) => {
    if (rs.tabs.length <= 1) return null;
    const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((t) => t.id === rs.activeTabId);
    const newIdx =
      direction === "left" ? (idx - 1 + sorted.length) % sorted.length : (idx + 1) % sorted.length;
    return { activeTabId: sorted[newIdx].id };
  });
});

export const jumpHintsActiveAtom = atom(false);

// Both use digits in visual order; Ctrl disambiguates runspace (⌃1) from tab (1).
const HINT_KEYS = [..."123456789"];

type JumpHintTargets = {
  byRunspaceId: Record<string, string>;
  byTabId: Record<string, string>;
};

const NO_HINT_TARGETS: JumpHintTargets = { byRunspaceId: {}, byTabId: {} };

export const jumpHintTargetsAtom = atom((get): JumpHintTargets => {
  if (!get(jumpHintsActiveAtom)) return NO_HINT_TARGETS;
  // Agent Runtime runspaces are mouse-only, so they get no hint keys.
  const summaries = get(runspaceSummariesAtom).filter((s) => !isAgentRuntimeRunspace(s));
  // Hint order must match the sidebar's visual order: task-bound group first, then shells.
  const ordered = [...summaries.filter((s) => s.taskId), ...summaries.filter((s) => !s.taskId)];
  const rs = get(activeRunspaceAtom);
  const tabs = rs ? [...rs.tabs].sort((a, b) => a.order - b.order) : [];

  const byRunspaceId: Record<string, string> = {};
  const byTabId: Record<string, string> = {};
  ordered.slice(0, HINT_KEYS.length).forEach((s, i) => {
    byRunspaceId[s.id] = HINT_KEYS[i];
  });
  tabs.slice(0, HINT_KEYS.length).forEach((t, i) => {
    byTabId[t.id] = HINT_KEYS[i];
  });
  return { byRunspaceId, byTabId };
});

export const jumpToHintAtom = atom(null, (get, set, input: { key: string; runspace: boolean }) => {
  // Read before dismissing: the targets atom empties once hints deactivate.
  const targets = get(jumpHintTargetsAtom);
  set(jumpHintsActiveAtom, false);
  const byId = input.runspace ? targets.byRunspaceId : targets.byTabId;
  const match = Object.entries(byId).find(([, key]) => key === input.key);
  if (!match) return;
  if (input.runspace) {
    set(activateRunspaceAtom, match[0]);
  } else {
    set(activateTerminalTabAtom, match[0]);
  }
});

export const updateTabTitleAtom = atom(null, (get, set, tabId: string, title: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, patchTabInState(state, tabId, { title }));
  // Shells retitle on every prompt, making this the signal that something may have
  // run in the tab — including a branch switch the cwd watcher cannot see.
  const tab = state.runspaces.flatMap((rs) => rs.tabs).find((t) => t.id === tabId);
  if (tab) void set(resolveWorktreeInfoAtom, [tabDisplayPath({ ...tab, title })]);
});

export const updateTabCwdAtom = atom(null, (get, set, tabId: string, cwd: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, patchTabInState(state, tabId, { cwd }));
  void set(resolveWorktreeInfoAtom, [cwd]);
});

export const reorderRunspacesAtom = atom(null, (get, set, fromId: string, toId: string) => {
  const state = get(resolvedStateAtom);
  const runspaces = reorderByOrder(state.runspaces, fromId, toId);
  if (!runspaces) return;
  set(terminalStateAtom, { ...state, runspaces });
});

export const reorderTabsAtom = atom(null, (get, set, fromId: string, toId: string) => {
  updateActiveRunspace(get, set, (rs) => {
    const tabs = reorderByOrder(rs.tabs, fromId, toId);
    return tabs ? { tabs } : null;
  });
});

export const moveActiveTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  updateActiveRunspace(get, set, (rs) => {
    const sorted = [...rs.tabs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((t) => t.id === rs.activeTabId);
    if (idx === -1) return null;
    const neighborIdx = direction === "left" ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= sorted.length) return null;
    const tabs = reorderByOrder(rs.tabs, sorted[idx].id, sorted[neighborIdx].id);
    return tabs ? { tabs } : null;
  });
});

export const moveActiveRunspaceAtom = atom(null, (get, set, direction: "up" | "down") => {
  const state = get(resolvedStateAtom);
  const sorted = [...state.runspaces].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((rs) => rs.id === state.activeRunspaceId);
  if (idx === -1) return;
  const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
  if (neighborIdx < 0 || neighborIdx >= sorted.length) return;
  const runspaces = reorderByOrder(state.runspaces, sorted[idx].id, sorted[neighborIdx].id);
  if (!runspaces) return;
  set(terminalStateAtom, { ...state, runspaces });
});

function stateToSnapshot(state: TerminalState): TerminalStateSnapshot {
  return {
    runspaces: state.runspaces.map((rs) => ({
      id: rs.id,
      // The backend re-derives kind from the id on save, so this value is never trusted.
      kind: rs.kind ?? "standard",
      sort_order: rs.order,
      tabs: rs.tabs.map((t) => ({
        id: t.id,
        cwd: tabDisplayPath(t),
        title: t.title,
        sort_order: t.order,
        terminal_session_id: t.sessionId ?? null,
      })),
    })),
  };
}

// active runspace/tab is resolved from the Tauri store hint in loadTerminalStateAtom;
// here it just defaults to the first runspace/tab.
function snapshotToState(snap: TerminalStateSnapshot): TerminalState | null {
  if (snap.runspaces.length === 0) return null;
  const runspaces: TerminalRunspace[] = snap.runspaces.map((rs) => ({
    id: rs.id,
    kind: rs.kind,
    order: rs.sort_order,
    activeTabId: rs.tabs[0]?.id ?? "",
    tabs: rs.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      order: t.sort_order,
      sessionId: t.terminal_session_id ?? undefined,
    })),
  }));
  const withTabs = runspaces.filter((rs) => rs.tabs.length > 0);
  return {
    runspaces: withTabs,
    activeRunspaceId: withTabs[0]?.id ?? "",
  };
}

export type SessionStatusEntry = {
  status: TerminalSessionStatus;
  exitCode?: number | null;
};

// sessionId → last known status. Seeded by the startup reconcile, kept fresh by the
// sidebar poll, and overridden optimistically by attach/exit handling in use-terminal.
// A session missing from the map is "unknown": panes still try to attach (the daemon may
// simply not have been reachable yet) and only an attach failure demotes it to lost.
export const sessionStatusAtom = atom<Record<string, SessionStatusEntry>>({});

export const setSessionStatusAtom = atom(
  null,
  (_get, set, sessionId: string, entry: SessionStatusEntry) => {
    set(sessionStatusAtom, (prev) => ({ ...prev, [sessionId]: entry }));
  },
);

// Live sessions (running/detached in the daemon) not bound to any tab — what the
// "Detached" sidebar group lists for reattach/terminate.
export const detachedSessionsAtom = atom<TerminalSession[]>([]);

function applySessionList(get: Getter, set: Setter, sessions: TerminalSession[]) {
  const statusMap: Record<string, SessionStatusEntry> = {};
  for (const s of sessions) {
    statusMap[s.id] = { status: s.status, exitCode: s.exit_code };
  }
  set(sessionStatusAtom, statusMap);

  const state = get(terminalStateAtom);
  const boundIds = new Set(
    (state?.runspaces ?? []).flatMap((rs) => rs.tabs.map((t) => t.sessionId)).filter(Boolean),
  );
  const detached = sessions.filter((s) => s.status === "detached" && !boundIds.has(s.id));
  set(detachedSessionsAtom, detached);
}

// terminal_list_sessions reconciles DB rows against the daemon backend-side, so this is
// both the status poll and the startup reconcile. Failures are non-fatal: keep the last
// known state and let attach failures surface as lost.
export const refreshSessionsAtom = atom(null, async (get, set) => {
  if (get(windowLabelAtom) !== MAIN_WINDOW_LABEL) return;
  let sessions: TerminalSession[];
  try {
    sessions = await terminalListSessions();
  } catch (e) {
    console.warn("terminal session refresh failed:", e);
    return;
  }
  applySessionList(get, set, sessions);
});

export const bindTabSessionAtom = atom(null, (get, set, tabId: string, sessionId: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, patchTabInState(state, tabId, { sessionId }));
});

export const terminateTabSessionAtom = atom(null, async (get, set, tabId: string) => {
  const state = get(resolvedStateAtom);
  const tab = state.runspaces.flatMap((rs) => rs.tabs).find((t) => t.id === tabId);
  const sessionId = tab?.sessionId;
  if (sessionId) {
    try {
      await terminalTerminate(sessionId);
    } catch (e) {
      console.warn("terminal terminate failed:", e);
    }
  }
  set(closeTerminalTabAtom, tabId);
});

// For lost/exited/failed tabs: keep the tab (and its cwd) but start a fresh session in
// it. Clearing sessionId makes the pane's connection effect create a new one.
export const startNewShellForTabAtom = atom(null, (get, set, tabId: string) => {
  releaseTabConnection(tabId);
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, patchTabInState(state, tabId, { sessionId: undefined }));
});

// Reattach a detached session into a tab. Prefers its original runspace and tab id (the
// tab id is burned into the child env as MONICA_TERMINAL_TAB_ID, so reusing it keeps
// hook-driven tab claims valid); falls back to the active runspace / a fresh id.
export const reattachSessionAtom = atom(null, (get, set, session: TerminalSession) => {
  const state = get(resolvedStateAtom);
  const allTabs = state.runspaces.flatMap((rs) => rs.tabs);
  if (allTabs.some((t) => t.sessionId === session.id)) return;

  const originalRs = state.runspaces.find((rs) => rs.id === session.runspace_id);
  // Merging an agent session into the active/first runspace would strip its agent_runtime
  // classification and pull it back into cycling; rebuild its runspace instead. Standard
  // sessions keep the merge fallback — any runspace is as good as another for them.
  const rebuildAgentRuntimeRs = !originalRs && session.kind === "agent" && session.runspace_id;
  const targetRs = rebuildAgentRuntimeRs
    ? undefined
    : (originalRs ??
      state.runspaces.find((rs) => rs.id === state.activeRunspaceId) ??
      state.runspaces[0]);
  if (!targetRs && !rebuildAgentRuntimeRs) return;

  const tabIdFree = session.tab_id && !allTabs.some((t) => t.id === session.tab_id);
  const tab: TerminalTab = {
    id: tabIdFree && session.tab_id ? session.tab_id : crypto.randomUUID(),
    title: "",
    cwd: session.cwd,
    order: targetRs ? targetRs.tabs.length : 0,
    sessionId: session.id,
  };

  if (targetRs) {
    set(terminalStateAtom, {
      ...state,
      activeRunspaceId: targetRs.id,
      runspaces: state.runspaces.map((rs) =>
        rs.id === targetRs.id ? { ...rs, tabs: [...rs.tabs, tab], activeTabId: tab.id } : rs,
      ),
    });
  } else {
    const maxOrder = state.runspaces.reduce((m, r) => Math.max(m, r.order), -1);
    const rs: TerminalRunspace = {
      id: session.runspace_id!,
      kind: "agent_runtime",
      tabs: [tab],
      activeTabId: tab.id,
      order: maxOrder + 1,
    };
    set(terminalStateAtom, {
      ...state,
      activeRunspaceId: rs.id,
      runspaces: [...state.runspaces, rs],
    });
  }
  set(detachedSessionsAtom, (prev) => prev.filter((s) => s.id !== session.id));
  set(terminalFocusRequestAtom, (c) => c + 1);
});

// Adopt a backend-created Agent Runtime session (claude-session:opened) into the topology: get-or-create
// its runspace, then bind a tab to the already-running session. Reattach-shaped rather than
// launch-shaped — the pane must attach to the live PTY, not spawn a second session. Unlike
// the user-initiated reattach/run atoms this never touches the active runspace/tab: the
// trigger is an external process, and yanking focus away from whatever the user is typing
// into would be hostile. Claude is already running backend-side, so nothing needs the mount.
export const adoptClaudeSessionAtom = atom(
  null,
  async (
    get,
    set,
    payload: { runspaceId: string; tabId: string; sessionId: string; cwd: string; title?: string },
  ) => {
    // Adopting into the fabricated fallback state would make loadTerminalStateAtom
    // early-return forever and later persist that fabricated layout over the saved one.
    if (get(terminalStateAtom) === null) {
      await set(loadTerminalStateAtom);
    }

    const state = get(resolvedStateAtom);
    const allTabs = state.runspaces.flatMap((rs) => rs.tabs);
    if (allTabs.some((t) => t.sessionId === payload.sessionId)) return;

    const existing = state.runspaces.find((rs) => rs.id === payload.runspaceId);
    const tab: TerminalTab = {
      id: allTabs.some((t) => t.id === payload.tabId) ? crypto.randomUUID() : payload.tabId,
      title: payload.title ?? "",
      cwd: payload.cwd,
      order: existing ? existing.tabs.length : 0,
      sessionId: payload.sessionId,
    };

    if (existing) {
      set(terminalStateAtom, {
        ...state,
        runspaces: state.runspaces.map((rs) =>
          rs.id === existing.id ? { ...rs, tabs: [...rs.tabs, tab] } : rs,
        ),
      });
    } else {
      const maxOrder = state.runspaces.reduce((m, r) => Math.max(m, r.order), -1);
      const rs: TerminalRunspace = {
        id: payload.runspaceId,
        // This atom only ever adopts Agent Runtime sessions, so the runspace it
        // materializes is by construction an agent-runtime one — no id parsing here.
        kind: "agent_runtime",
        tabs: [tab],
        activeTabId: tab.id,
        order: maxOrder + 1,
      };
      set(terminalStateAtom, {
        ...state,
        runspaces: [...state.runspaces, rs],
      });
    }

    // A reconcile that ran before this adoption may have classified the (running, unbound)
    // session as detached; it has a tab now, so drop the stale sidebar entry (same as
    // reattach) before someone terminates it from there.
    set(detachedSessionsAtom, (prev) => prev.filter((s) => s.id !== payload.sessionId));
  },
);

export type TabMenuState = {
  tabId: string;
  anchor: { top: number; bottom: number; left: number };
  confirmingTerminate: boolean;
};

export const tabMenuAtom = atom<TabMenuState | null>(null);

export const tabByIdAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return new Map(state.runspaces.flatMap((rs) => rs.tabs).map((t) => [t.id, t]));
});

export function enrichRunspacesWithEnv(
  runspaces: TerminalRunspace[],
  runspaceToTask: Map<string, string>,
  envByTask: Map<string, [string, string][]>,
): TerminalRunspace[] {
  return runspaces.map((rs) => {
    const taskId = runspaceToTask.get(rs.id);
    const env = taskId ? envByTask.get(taskId) : undefined;
    return { ...rs, taskId, env: env && env.length > 0 ? env : undefined };
  });
}

export function applyHint(state: TerminalState, hint: WorkbenchHint): TerminalState {
  const resolved = resolveWorkbenchActive(state.runspaces, hint);
  return {
    ...state,
    activeRunspaceId: resolved.activeRunspaceId,
    runspaces: state.runspaces.map((rs) =>
      rs.id === resolved.activeRunspaceId ? { ...rs, activeTabId: resolved.activeTabId } : rs,
    ),
  };
}

// Concurrent loads (e.g. WorkBench mount racing createTaskRunspaceAtom) must share
// one promise so a slower load cannot overwrite state mutated in between.
const loadInFlightAtom = atom<Promise<void> | null>(null);

export const loadTerminalStateAtom = atom(null, (get, set): Promise<void> => {
  if (get(terminalStateAtom) !== null) return Promise.resolve();

  const inFlight = get(loadInFlightAtom);
  if (inFlight) return inFlight;

  const windowLabel = get(windowLabelAtom);

  const promise = (async () => {
    try {
      // The session list is fetched with its own catch: it triggers the backend's daemon
      // reconcile, and a daemon failure must not fall into the catch below, which would
      // replace (and then persist) the saved layout with an empty one. Unknown statuses
      // just mean panes attempt to attach and demote themselves to lost on failure.
      const [snap, benchMap, sessions] = await Promise.all([
        terminalLoadState(windowLabel),
        listBenchRunspaceMap(),
        terminalListSessions().catch((e) => {
          console.warn("terminal session reconcile failed:", e);
          return null;
        }),
      ]);
      let state = snapshotToState(snap);
      if (state && state.runspaces.length > 0) {
        const runspaceToTask = new Map(benchMap.map(([rsId, taskId]) => [rsId, taskId]));
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
        state.runspaces = enrichRunspacesWithEnv(state.runspaces, runspaceToTask, envByTask);
        const hint = get(pendingWorkbenchHintAtom);
        if (hint) {
          set(pendingWorkbenchHintAtom, null);
          state = applyHint(state, hint);
        }
        set(terminalStateAtom, state);
        if (windowLabel === MAIN_WINDOW_LABEL && sessions) applySessionList(get, set, sessions);
        void set(resolveWorktreeInfoAtom);
        return;
      }
      if (windowLabel === MAIN_WINDOW_LABEL && sessions) applySessionList(get, set, sessions);
    } catch {
      // first launch or empty DB
    }
    set(pendingWorkbenchHintAtom, null);
    set(terminalStateAtom, initialState());
  })().finally(() => {
    set(loadInFlightAtom, null);
  });

  set(loadInFlightAtom, promise);
  return promise;
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
  set(terminalStateAtom, patchTabInState(state, tabId, { launch: undefined }));
});

const saveTimerAtom = atom<number | undefined>(undefined);

export const saveTerminalStateAtom = atom(null, (get, set) => {
  const current = get(terminalStateAtom);
  if (!current) return;
  const prev = get(saveTimerAtom);
  if (prev) clearTimeout(prev);
  const windowLabel = get(windowLabelAtom);
  const snapshot = stateToSnapshot(current);
  const timer = window.setTimeout(() => {
    terminalSaveState(windowLabel, snapshot).catch((e) => console.warn("terminal save failed:", e));
  }, 500);
  set(saveTimerAtom, timer);
});
