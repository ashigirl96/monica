import { atom, getDefaultStore } from "jotai";
import type {
  ClaudeConversationStatus,
  ClaudeSessionStatus,
  ClaudeTranscriptRecord,
  TaskRunWaitReason,
} from "@/commands/bindings";
import {
  claudeListSessions,
  claudeSessionTranscript,
  onClaudeSessionMessage,
  onClaudeSessionOpened,
  onClaudeSessionStateChanged,
} from "@/commands/claude-runtime";
import { adoptClaudeSessionAtom } from "@/features/work-bench/store";
import { MAIN_WINDOW_LABEL, windowLabelAtom } from "@/stores/ui-state";

// Hook/JSONL-driven observability for Claude Runtime sessions, keyed by claude_session_id.
// The backend is the state machine (hooks → claude_sessions → drain → events); this map is
// a passive mirror the UI reads.
export type ClaudeSessionRuntimeState = {
  sessionStatus: ClaudeSessionStatus;
  conversationStatus: ClaudeConversationStatus;
  waitReason: TaskRunWaitReason | null;
  messages: ClaudeTranscriptRecord[];
};

export const claudeSessionStatesAtom = atom<ReadonlyMap<string, ClaudeSessionRuntimeState>>(
  new Map<string, ClaudeSessionRuntimeState>(),
);

function mergeClaudeSessionState(
  claudeSessionId: string,
  update: Partial<ClaudeSessionRuntimeState>,
): void {
  const store = getDefaultStore();
  const current = store.get(claudeSessionStatesAtom);
  const previous = current.get(claudeSessionId) ?? {
    sessionStatus: "active" as ClaudeSessionStatus,
    conversationStatus: "idle" as ClaudeConversationStatus,
    waitReason: null,
    messages: [],
  };
  const next = new Map(current);
  next.set(claudeSessionId, { ...previous, ...update });
  store.set(claudeSessionStatesAtom, next);
}

function appendClaudeSessionMessages(
  claudeSessionId: string,
  records: ClaudeTranscriptRecord[],
): void {
  const store = getDefaultStore();
  const previous = store.get(claudeSessionStatesAtom).get(claudeSessionId);
  mergeClaudeSessionState(claudeSessionId, {
    messages: [...(previous?.messages ?? []), ...records],
  });
}

// App-lifetime owner for Agent Runtime session adoption. A single claude-session:opened listener
// (module init, not a React effect, so StrictMode can't double-register) materializes the
// tab in the main window only — the event broadcasts to every window, and each window has
// its own topology. The guard reads windowLabelAtom inside the callback because
// initClaudeRuntime() runs before bootstrap sets the label.
//
// The event is best-effort by design: a missed one (no webview alive, label not set yet)
// still leaves a running session whose mapping row stays active in claude_sessions —
// recoverClaudeSessions() re-adopts those orphans on the next startup.
export function initClaudeRuntime(): void {
  const store = getDefaultStore();
  void onClaudeSessionOpened((payload) => {
    if (store.get(windowLabelAtom) !== MAIN_WINDOW_LABEL) return;
    void store.set(adoptClaudeSessionAtom, {
      runspaceId: payload.runspace_id,
      tabId: payload.tab_id,
      sessionId: payload.session_id,
      cwd: payload.cwd,
      title: payload.title ?? undefined,
    });
  });
  void onClaudeSessionStateChanged((payload) => {
    mergeClaudeSessionState(payload.claude_session_id, {
      sessionStatus: payload.session_status,
      conversationStatus: payload.conversation_status,
      waitReason: payload.wait_reason,
    });
  });
  void onClaudeSessionMessage((payload) => {
    appendClaudeSessionMessages(payload.claude_session_id, payload.records);
  });
}

// Startup recovery: re-adopt every Claude session whose PTY survived the restart. The
// backend reconciles liveness before answering and fails closed when the daemon is
// unreachable, so an `active` row here is always a session verified against the daemon
// moments ago — the catch below skipping recovery on error is what keeps stale rows from
// materializing as tabs. Adoption dedupes on sessionId, so tabs already restored from the
// layout snapshot are untouched — only orphans materialize.
export async function recoverClaudeSessions(): Promise<void> {
  const store = getDefaultStore();
  if (store.get(windowLabelAtom) !== MAIN_WINDOW_LABEL) return;
  let sessions;
  try {
    sessions = await claudeListSessions();
  } catch (e) {
    console.warn("failed to list claude sessions for recovery:", e);
    return;
  }
  for (const session of sessions) {
    if (session.status !== "active") continue;
    await store.set(adoptClaudeSessionAtom, {
      runspaceId: session.runspace_id,
      tabId: session.tab_id,
      sessionId: session.terminal_session_id,
      cwd: session.cwd,
      title: session.name ?? undefined,
    });
    mergeClaudeSessionState(session.claude_session_id, {
      sessionStatus: session.status,
      conversationStatus: session.conversation_status,
      waitReason: session.wait_reason,
    });
    // Push events emitted while no webview was alive are gone; the transcript file is the
    // durable record, so seed the mirror from a full pull.
    try {
      const records = await claudeSessionTranscript(session.claude_session_id);
      if (records.length > 0) {
        mergeClaudeSessionState(session.claude_session_id, { messages: records });
      }
    } catch (e) {
      console.warn(`failed to load transcript for ${session.claude_session_id}:`, e);
    }
  }
}
