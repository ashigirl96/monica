import { atom } from "jotai";
import {
  terminalListSessions,
  terminalLoadState,
  terminalSaveState,
  type TerminalStateSnapshot,
} from "@/commands/terminal";
import { listBenchRunspaceMap, taskShellEnv } from "@/commands/task";
import { MAIN_WINDOW_LABEL, pendingWorkbenchHintAtom, windowLabelAtom } from "@/stores/ui-state";
import {
  applyHint,
  enrichRunspacesWithEnv,
  initialState,
  tabDisplayPath,
  terminalStateAtom,
  warnTerminal,
  type TerminalRunspace,
  type TerminalState,
} from "@/features/work-bench/store";
import { applySessionList } from "@/features/work-bench/session-status";
import { resolveWorktreeInfoAtom } from "@/features/work-bench/worktree-resolver";

function stateToSnapshot(state: TerminalState): TerminalStateSnapshot {
  return {
    runspaces: state.runspaces.map((rs) => ({
      id: rs.id,
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
          warnTerminal("session reconcile", e);
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

const saveTimerAtom = atom<number | undefined>(undefined);

export const saveTerminalStateAtom = atom(null, (get, set) => {
  const current = get(terminalStateAtom);
  if (!current) return;
  const prev = get(saveTimerAtom);
  if (prev) clearTimeout(prev);
  const windowLabel = get(windowLabelAtom);
  const snapshot = stateToSnapshot(current);
  const timer = window.setTimeout(() => {
    terminalSaveState(windowLabel, snapshot).catch((e) => warnTerminal("save", e));
  }, 500);
  set(saveTimerAtom, timer);
});
