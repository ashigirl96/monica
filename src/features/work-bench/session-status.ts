import { atom, type Getter, type Setter } from "jotai";
import {
  terminalListSessions,
  type AgentSessionStatus,
  type TerminalSession,
  type TerminalSessionStatus,
} from "@/commands/terminal";
import type { TaskRunWaitReason } from "@/commands/task";
import { MAIN_WINDOW_LABEL, windowLabelAtom } from "@/stores/ui-state";
import { terminalStateAtom, warnTerminal } from "@/features/work-bench/store";

export type SessionStatusEntry = {
  status: TerminalSessionStatus;
  exitCode?: number | null;
  agentStatus?: AgentSessionStatus | null;
  agentWaitReason?: TaskRunWaitReason | null;
  providerSessionId?: string | null;
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

export function applySessionList(get: Getter, set: Setter, sessions: TerminalSession[]) {
  const statusMap: Record<string, SessionStatusEntry> = {};
  for (const s of sessions) {
    statusMap[s.id] = {
      status: s.status,
      exitCode: s.exit_code,
      agentStatus: s.agent_status,
      agentWaitReason: s.agent_wait_reason,
      providerSessionId: s.provider_session_id,
    };
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
    warnTerminal("session refresh", e);
    return;
  }
  applySessionList(get, set, sessions);
});
