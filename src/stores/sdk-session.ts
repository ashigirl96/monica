import { getDefaultStore } from "jotai";
import { onSdkSessionOpened } from "@/commands/sdk";
import { adoptSdkSessionAtom } from "@/features/work-bench/store";
import { MAIN_WINDOW_LABEL, windowLabelAtom } from "@/stores/ui-state";

// App-lifetime owner for SDK session adoption. A single sdk-session:opened listener
// (module init, not a React effect, so StrictMode can't double-register) materializes the
// tab in the main window only — the event broadcasts to every window, and each window has
// its own topology. The guard reads windowLabelAtom inside the callback because
// initSdkSessions() runs before bootstrap sets the label.
//
// The event is best-effort by design: a missed one (no webview alive, label not set yet)
// still leaves a running session whose row the next reconcile demotes to detached — it then
// surfaces in the sidebar's Detached group for manual reattach. Automatic re-adoption of
// those orphans is MVP3's recovery work.
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
