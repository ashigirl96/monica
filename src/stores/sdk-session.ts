import { getDefaultStore } from "jotai";
import { claudeListSessions, onSdkSessionOpened } from "@/commands/sdk";
import { adoptSdkSessionAtom } from "@/features/work-bench/store";
import { MAIN_WINDOW_LABEL, windowLabelAtom } from "@/stores/ui-state";

// App-lifetime owner for SDK session adoption. A single sdk-session:opened listener
// (module init, not a React effect, so StrictMode can't double-register) materializes the
// tab in the main window only — the event broadcasts to every window, and each window has
// its own topology. The guard reads windowLabelAtom inside the callback because
// initSdkSessions() runs before bootstrap sets the label.
//
// The event is best-effort by design: a missed one (no webview alive, label not set yet)
// still leaves a running session whose mapping row stays active in claude_sessions —
// recoverClaudeSessions() re-adopts those orphans on the next startup.
export function initSdkSessions(): void {
  const store = getDefaultStore();
  void onSdkSessionOpened((payload) => {
    if (store.get(windowLabelAtom) !== MAIN_WINDOW_LABEL) return;
    void store.set(adoptSdkSessionAtom, {
      runspaceId: payload.runspace_id,
      tabId: payload.tab_id,
      sessionId: payload.session_id,
      cwd: payload.cwd,
      title: payload.title ?? undefined,
    });
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
    await store.set(adoptSdkSessionAtom, {
      runspaceId: session.runspace_id,
      tabId: session.tab_id,
      sessionId: session.terminal_session_id,
      cwd: session.cwd,
      title: session.name ?? undefined,
    });
  }
}
