import type { PopoverAnchor } from "@/components/popover-menu";
import { shortPath } from "@/lib/paths";
import { atom, type Getter, type Setter } from "jotai";
import { terminalDetach, terminalTerminate, type TerminalSession } from "@/commands/terminal";
import {
  attachTerminalTab,
  listTabTaskBindings,
  makeMainTaskRun,
  primaryTabId,
  taskShellEnv,
  type TabTaskBinding,
} from "@/commands/task";
import { readRunspacePlan, type PlanPreview } from "@/commands/plan";
import type { WorktreeInfo } from "@/commands/git";
import { releaseTabConnection } from "@/features/work-bench/terminal-connections";
import {
  MAIN_WINDOW_LABEL,
  type WorkbenchHint,
  resolveWorkbenchActive,
  windowLabelAtom,
} from "@/stores/ui-state";
import { refreshTaskSummariesAtom } from "@/stores/workboard";
import { pushErrorToast } from "@/stores/toast";
import { jumpHintsActiveAtom } from "@/features/work-bench/jump-hints";
import { detachedSessionsAtom, refreshSessionsAtom } from "@/features/work-bench/session-status";
import { loadTerminalStateAtom } from "@/features/work-bench/persistence";
import {
  resolveWorktreeInfoAtom,
  worktreeInfoByPathAtom,
} from "@/features/work-bench/worktree-resolver";

export const terminalFocusRequestAtom = atom(0);

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
  taskId?: string;
  env?: [string, string][];
  tabs: TerminalTab[];
  activeTabId: string;
  order: number;
  /// Pin is a runspace ↔ tab 1:1 pair: holding the tab id here (instead of a bool on the
  /// tab) makes "two pinned tabs in one runspace" structurally unrepresentable. The pinned
  /// tab can be neither detached nor terminated until unpinned.
  pinnedTabId?: string;
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

// Callers guarantee at least one tab remains after removal.
function removeTabFromRunspace(
  rs: TerminalRunspace,
  tabId: string,
): Pick<TerminalRunspace, "tabs" | "activeTabId"> {
  const idx = rs.tabs.findIndex((t) => t.id === tabId);
  const tabs = rs.tabs.filter((t) => t.id !== tabId);
  const activeTabId =
    rs.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)].id : rs.activeTabId;
  return { tabs, activeTabId };
}

function maxRunspaceOrder(runspaces: TerminalRunspace[]): number {
  return runspaces.reduce((m, r) => Math.max(m, r.order), -1);
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

export function tabDisplayPath(tab: TerminalTab): string {
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

export function initialState(): TerminalState {
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
  taskId: string | undefined;
  group: RunspaceNavGroup;
  title: string;
  description: string;
  tabCount: number;
  isActive: boolean;
};

// Emitted in the sidebar's visual order (pinned → task runs → shells), with `group`
// carrying the grouping, so the sidebar, jump hints, and alt+j/k all share one
// definition of it instead of re-deriving it.
export const runspaceSummariesAtom = atom<RunspaceSummary[]>((get) => {
  const state = get(resolvedStateAtom);
  const worktrees = get(worktreeInfoByPathAtom);
  return orderRunspacesForNav(state.runspaces).map((rs) => ({
    id: rs.id,
    taskId: rs.taskId,
    group: runspaceNavGroup(rs),
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

export function warnTerminal(action: string, e: unknown): void {
  console.warn(`terminal ${action} failed:`, e);
}

function endTabSession(sessionId: string | undefined, op: "detach" | "terminate"): Promise<void> {
  if (!sessionId) return Promise.resolve();
  const run = op === "detach" ? terminalDetach : terminalTerminate;
  return run(sessionId).catch((e: unknown) => warnTerminal(op, e));
}

// Closing a tab or runspace detaches the session (the process keeps running under the
// daemon and shows up in the Detached group); only an explicit terminate kills it.
export function detachTab(tab: TerminalTab): Promise<void> {
  return endTabSession(releaseTabConnection(tab.id) ?? tab.sessionId, "detach");
}

export function terminateTab(tab: TerminalTab): Promise<void> {
  return endTabSession(releaseTabConnection(tab.id) ?? tab.sessionId, "terminate");
}

export const removeRunspaceAtom = atom(
  null,
  (get, set, rsId: string, mode: "detach" | "terminate" = "detach") => {
    const state = get(resolvedStateAtom);
    const rs = state.runspaces.find((r) => r.id === rsId);
    if (!rs || rs.pinnedTabId) return;

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

// The single definition of the sidebar's grouping — every consumer (sidebar sections,
// navigation order, summaries) derives from this so the groups can never drift apart.
export type RunspaceNavGroup = "pinned" | "task" | "shell";

function runspaceNavGroup(rs: TerminalRunspace): RunspaceNavGroup {
  if (rs.pinnedTabId) return "pinned";
  return rs.taskId ? "task" : "shell";
}

const NAV_GROUP_RANK: Record<RunspaceNavGroup, number> = { pinned: 0, task: 1, shell: 2 };

// Navigation must follow the sidebar's visual order: pinned first, then task-bound, then
// shells. Ordering by `order` alone would interleave the groups (createRunspace inserts a
// shell next to the active task-bound runspace), so alt+j/k would jump differently than the
// sidebar reads.
function orderRunspacesForNav(runspaces: TerminalRunspace[]): TerminalRunspace[] {
  return [...runspaces].sort(
    (a, b) =>
      NAV_GROUP_RANK[runspaceNavGroup(a)] - NAV_GROUP_RANK[runspaceNavGroup(b)] ||
      a.order - b.order,
  );
}

export const cycleRunspaceAtom = atom(null, (get, set, direction: "up" | "down") => {
  const state = get(resolvedStateAtom);
  const sorted = orderRunspacesForNav(state.runspaces);
  if (sorted.length <= 1) return;

  const idx = sorted.findIndex((rs) => rs.id === state.activeRunspaceId);
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

  // Guards every close path at once: cmd+w, the header × button, the context menu,
  // and any stray caller — a pinned tab only leaves via unpin.
  if (rs.pinnedTabId === targetId) return;

  if (rs.tabs.length <= 1) {
    set(removeRunspaceAtom, rs.id, isSecondary ? "terminate" : "detach");
    return;
  }

  if (isSecondary) {
    void terminateTab(target);
  } else {
    detachTab(target);
  }

  set(terminalStateAtom, patchRunspaceInState(state, rs.id, removeTabFromRunspace(rs, targetId)));
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

export const bindTabSessionAtom = atom(null, (get, set, tabId: string, sessionId: string) => {
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, patchTabInState(state, tabId, { sessionId }));
});

export const terminateTabSessionAtom = atom(null, async (get, set, tabId: string) => {
  // The kill happens before closeTerminalTabAtom runs, so its pin guard cannot stop it.
  if (get(pinnedTabIdsAtom).has(tabId)) return;
  const state = get(resolvedStateAtom);
  const tab = state.runspaces.flatMap((rs) => rs.tabs).find((t) => t.id === tabId);
  await endTabSession(tab?.sessionId, "terminate");
  set(closeTerminalTabAtom, tabId);
});

// Pinned tabs looked up by id, for guards that only have a tabId (terminate, exit
// handling, context menu); paths that already found the runspace check rs.pinnedTabId.
export const pinnedTabIdsAtom = atom((get) => {
  const state = get(resolvedStateAtom);
  return new Set(
    state.runspaces.flatMap((rs) => (rs.pinnedTabId !== undefined ? [rs.pinnedTabId] : [])),
  );
});

export const toggleTabPinAtom = atom(null, (get, set, tabId?: string) => {
  // Main window only: a secondary window terminates every session and saves an empty
  // snapshot on close (main.tsx), which would kill a pinned tab without passing any guard.
  if (get(windowLabelAtom) !== MAIN_WINDOW_LABEL) return;

  const state = get(resolvedStateAtom);
  const rs = tabId
    ? state.runspaces.find((r) => r.tabs.some((t) => t.id === tabId))
    : state.runspaces.find((r) => r.id === state.activeRunspaceId);
  if (!rs) return;
  const target = rs.tabs.find((t) => t.id === (tabId ?? rs.activeTabId));
  if (!target) return;

  if (rs.pinnedTabId === target.id) {
    // Unpin only clears the flag: the runspace falls back to its group by taskId, and
    // tabs added while pinned stay where they are.
    set(terminalStateAtom, patchRunspaceInState(state, rs.id, { pinnedTabId: undefined }));
    return;
  }

  if (rs.pinnedTabId) {
    // The runspace is already pinned via another tab: re-point the pin there instead of
    // extracting a second pinned runspace — the 1:1 pair moves within the runspace and
    // its position in PINNED stays put.
    set(terminalStateAtom, patchRunspaceInState(state, rs.id, { pinnedTabId: target.id }));
    return;
  }

  // maxOrder + 1 lands the runspace at the end of the PINNED group (groups only rank
  // above `order`, and nothing sorts after the global maximum).
  const maxOrder = maxRunspaceOrder(state.runspaces);

  if (rs.taskId || rs.tabs.length === 1) {
    // Task runspaces pin whole — keeping the runspace id intact preserves the
    // MONICA_TERMINAL_TAB_ID-based hook claims. A single-tab shell pins in place too:
    // extraction would only rename the runspace id ("move the tab out, collapse the
    // now-empty original" is observationally the same).
    set(
      terminalStateAtom,
      patchRunspaceInState(state, rs.id, { pinnedTabId: target.id, order: maxOrder + 1 }),
    );
    return;
  }

  // Multi-tab shell: pull the tab out into its own pinned runspace so the siblings
  // stay in SHELLS instead of being dragged into PINNED with it.
  const remaining = removeTabFromRunspace(rs, target.id);
  const pinnedRs: TerminalRunspace = {
    id: crypto.randomUUID(),
    tabs: [{ ...target, order: 0 }],
    activeTabId: target.id,
    pinnedTabId: target.id,
    order: maxOrder + 1,
  };
  const followTab = state.activeRunspaceId === rs.id && rs.activeTabId === target.id;
  set(terminalStateAtom, {
    runspaces: [
      ...state.runspaces.map((r) => (r.id === rs.id ? { ...r, ...remaining } : r)),
      pinnedRs,
    ],
    activeRunspaceId: followTab ? pinnedRs.id : state.activeRunspaceId,
  });
});

// For lost/exited/failed tabs: keep the tab (and its cwd) but start a fresh session in
// it. Clearing sessionId makes the pane's connection effect create a new one.
export const startNewShellForTabAtom = atom(null, (get, set, tabId: string) => {
  releaseTabConnection(tabId);
  const state = get(resolvedStateAtom);
  set(terminalStateAtom, patchTabInState(state, tabId, { sessionId: undefined }));
});

// The tab's process exited (typed `exit`, crash). A pinned tab must never sit dead —
// the exit is out of the app's control — so it respawns a shell in place of closing.
export const tabExitedAtom = atom(null, (get, set, tabId: string) => {
  if (get(pinnedTabIdsAtom).has(tabId)) {
    set(startNewShellForTabAtom, tabId);
  } else {
    set(closeTerminalTabAtom, tabId);
  }
});

// Reattach a detached session into a tab. Prefers its original runspace and tab id (the
// tab id is burned into the child env as MONICA_TERMINAL_TAB_ID, so reusing it keeps
// hook-driven tab claims valid); falls back to the active runspace / a fresh id.
export const reattachSessionAtom = atom(null, (get, set, session: TerminalSession) => {
  const state = get(resolvedStateAtom);
  const allTabs = state.runspaces.flatMap((rs) => rs.tabs);
  if (allTabs.some((t) => t.sessionId === session.id)) return;

  const targetRs =
    state.runspaces.find((rs) => rs.id === session.runspace_id) ??
    state.runspaces.find((rs) => rs.id === state.activeRunspaceId) ??
    state.runspaces[0];
  if (!targetRs) return;

  const tabIdFree = session.tab_id && !allTabs.some((t) => t.id === session.tab_id);
  const tab: TerminalTab = {
    id: tabIdFree && session.tab_id ? session.tab_id : crypto.randomUUID(),
    title: "",
    cwd: session.cwd,
    order: targetRs.tabs.length,
    sessionId: session.id,
  };

  set(terminalStateAtom, {
    ...state,
    activeRunspaceId: targetRs.id,
    runspaces: state.runspaces.map((rs) =>
      rs.id === targetRs.id ? { ...rs, tabs: [...rs.tabs, tab], activeTabId: tab.id } : rs,
    ),
  });
  set(detachedSessionsAtom, (prev) => prev.filter((s) => s.id !== session.id));
  set(terminalFocusRequestAtom, (c) => c + 1);
});

export type TabMenuState = {
  tabId: string;
  anchor: PopoverAnchor;
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
    await set(loadTerminalStateAtom);

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

    const maxOrder = maxRunspaceOrder(state.runspaces);
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

export type TabMoveTarget = {
  runspaceId: string;
  taskId: string;
  env?: [string, string][];
};

// Move a tab into a task's bench runspace, creating the runspace when the bench has never been
// opened here. The tab keeps its id (hook claims key on it), its session and its cwd — only the
// layout changes. A source left empty collapses; a pin on the moved tab is dropped, since a
// pinned tab must stay put and this move is the user's explicit say-so that it should not.
// `follow` forces the target active; otherwise focus follows only if the moved tab was the one in
// front, so a background reconcile never yanks the user out of what they are looking at.
export function moveTabToRunspace(
  state: TerminalState,
  tabId: string,
  target: TabMoveTarget,
  follow: boolean,
): TerminalState {
  const source = state.runspaces.find((rs) => rs.tabs.some((t) => t.id === tabId));
  if (!source || source.id === target.runspaceId) return state;
  const tab = source.tabs.find((t) => t.id === tabId)!;

  const wasInFront = state.activeRunspaceId === source.id && source.activeTabId === tabId;
  const activate = follow || wasInFront;

  const withoutSource = state.runspaces
    .filter((rs) => rs.id !== source.id || rs.tabs.length > 1)
    .map((rs) => {
      if (rs.id !== source.id) return rs;
      return {
        ...rs,
        ...removeTabFromRunspace(rs, tabId),
        pinnedTabId: rs.pinnedTabId === tabId ? undefined : rs.pinnedTabId,
      };
    });

  const existing = withoutSource.find((rs) => rs.id === target.runspaceId);
  let runspaces: TerminalRunspace[];
  if (existing) {
    const moved = { ...tab, order: existing.tabs.length };
    runspaces = withoutSource.map((rs) =>
      rs.id === existing.id
        ? {
            ...rs,
            tabs: [...rs.tabs, moved],
            activeTabId: activate ? moved.id : rs.activeTabId,
          }
        : rs,
    );
  } else {
    const moved = { ...tab, order: 0 };
    runspaces = [
      ...withoutSource,
      {
        id: target.runspaceId,
        taskId: target.taskId,
        env: target.env,
        tabs: [moved],
        activeTabId: moved.id,
        order: maxRunspaceOrder(withoutSource) + 1,
      },
    ];
  }

  const activeSurvived = runspaces.some((rs) => rs.id === state.activeRunspaceId);
  return {
    runspaces,
    activeRunspaceId: activate || !activeSurvived ? target.runspaceId : state.activeRunspaceId,
  };
}

// The tabs whose runspace disagrees with the binding the backend holds for them. Tabs this window
// does not show (another window, a closed tab) are not its business.
export function planTabMoves(
  state: TerminalState,
  bindings: TabTaskBinding[],
): { tabId: string; runspaceId: string; taskId: string }[] {
  const runspaceByTab = new Map(
    state.runspaces.flatMap((rs) => rs.tabs.map((t) => [t.id, rs.id] as const)),
  );
  return bindings
    .filter((b) => {
      const current = runspaceByTab.get(b.terminal_tab_id);
      return current !== undefined && current !== b.runspace_id;
    })
    .map((b) => ({ tabId: b.terminal_tab_id, runspaceId: b.runspace_id, taskId: b.task_id }));
}

async function moveTabIntoTask(
  get: Getter,
  set: Setter,
  tabId: string,
  target: TabMoveTarget,
  follow: boolean,
): Promise<void> {
  const state = get(resolvedStateAtom);
  const targetKnown = state.runspaces.some((rs) => rs.id === target.runspaceId);
  const env =
    target.env ?? (targetKnown ? undefined : await taskShellEnv(target.taskId).catch(() => []));
  set(
    terminalStateAtom,
    moveTabToRunspace(
      get(resolvedStateAtom),
      tabId,
      {
        ...target,
        env: env && env.length > 0 ? env : undefined,
      },
      follow,
    ),
  );
}

// GUI attach ("Attach to Task…" in the tab menu): bind the tab's session to the task as its Main
// Run, then pull the tab into the task's runspace right away rather than waiting for the poll.
export const attachTabToTaskAtom = atom(null, async (get, set, tabId: string, taskId: string) => {
  const tab = get(tabByIdAtom).get(tabId);
  if (!tab?.sessionId) return;
  let result;
  try {
    result = await attachTerminalTab(taskId, tabId, tab.sessionId, tabDisplayPath(tab));
  } catch (e) {
    pushErrorToast(e instanceof Error ? e.message : String(e));
    return;
  }
  await moveTabIntoTask(
    get,
    set,
    tabId,
    {
      runspaceId: result.runspace_id,
      taskId: result.task_id,
      env: result.env.length > 0 ? result.env : undefined,
    },
    true,
  );
  set(terminalFocusRequestAtom, (c) => c + 1);
  await Promise.all([set(refreshTaskSummariesAtom), set(refreshPrimaryTabAtom)]);
});

// `monica task attach` runs in another process and cannot touch this window's layout, so the
// sidebar poll asks the backend which tab belongs to which task's runspace and moves the strays.
export const reconcileTabBindingsAtom = atom(null, async (get, set) => {
  if (get(terminalStateAtom) === null) return;
  const bindings = await listTabTaskBindings();
  for (const move of planTabMoves(get(resolvedStateAtom), bindings)) {
    await moveTabIntoTask(get, set, move.tabId, move, false);
  }
});

// The tab whose "Attach to Task…" picker is open.
export const attachPickerTabIdAtom = atom<string | null>(null);
