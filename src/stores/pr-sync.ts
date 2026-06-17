import { atom, getDefaultStore } from "jotai";
import { forceSyncPullRequests, onPrSyncCompleted } from "@/commands/pull_request";
import { queryClient } from "@/stores/query-client";
import { invalidateTaskSummaries } from "@/stores/query-keys";
import { pushErrorToast, pushInfoToast } from "@/stores/toast";

// The forced sync is debounced while one is genuinely running in the backend; the in-flight
// flag is normally cleared by the pr-sync-completed event. But the backend's event emit is
// best-effort (it logs and swallows emit failures), so a missed event would wedge this
// module-global flag — and cmd+r with it — forever. This backstop clears it after the
// timeout if no completion event arrived.
const PR_SYNC_INFLIGHT_TIMEOUT_MS = 30_000;

export const prSyncInFlightAtom = atom(false);
export const prSyncLastSyncedAtom = atom<number | null>(null);

let inFlightTimer: ReturnType<typeof setTimeout> | undefined;

function clearInFlightTimer() {
  if (inFlightTimer) {
    clearTimeout(inFlightTimer);
    inFlightTimer = undefined;
  }
}

export const forceSyncPullRequestsAtom = atom(null, async (get, set) => {
  if (get(prSyncInFlightAtom)) return;
  set(prSyncInFlightAtom, true);
  try {
    await forceSyncPullRequests();
    clearInFlightTimer();
    // A near-instant sync can fire the completion event during the await above, clearing the
    // flag before we get here; only arm the backstop while we're still genuinely waiting.
    if (get(prSyncInFlightAtom)) {
      inFlightTimer = setTimeout(() => set(prSyncInFlightAtom, false), PR_SYNC_INFLIGHT_TIMEOUT_MS);
    }
  } catch (e) {
    clearInFlightTimer();
    set(prSyncInFlightAtom, false);
    pushErrorToast(e instanceof Error ? e.message : String(e));
  }
});

// App-lifetime owner for PR sync state. A single pr-sync-completed listener (module init,
// not a React effect, so StrictMode can't double-register) refreshes the cache, records the
// timestamp the header reads, clears the in-flight flag, and toasts.
export function initPrSync(): void {
  const store = getDefaultStore();
  void onPrSyncCompleted(() => {
    clearInFlightTimer();
    void invalidateTaskSummaries(queryClient);
    store.set(prSyncInFlightAtom, false);
    store.set(prSyncLastSyncedAtom, Date.now());
    pushInfoToast("PR status refreshed");
  });
}
