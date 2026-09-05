import { atom, getDefaultStore } from "jotai";
import { forceSyncGithub, onGithubSyncCompleted } from "@/commands/github_sync";
import { queryClient } from "@/stores/query-client";
import { refetchTaskSummaries } from "@/stores/query-keys";
import { activeSpaceAtom } from "@/stores/space";
import { pushErrorToast, pushInfoToast } from "@/stores/toast";

// The forced sync is debounced while one is genuinely running in the backend; the in-flight
// flag is normally cleared by the github-sync-completed event. But the backend's event emit is
// best-effort (it logs and swallows emit failures), so a missed event would wedge this
// module-global flag — and cmd+r with it — forever. This backstop clears it after the
// timeout if no completion event arrived.
const GITHUB_SYNC_INFLIGHT_TIMEOUT_MS = 30_000;

export const githubSyncInFlightAtom = atom(false);
export const githubSyncLastSyncedAtom = atom<number | null>(null);

let inFlightTimer: ReturnType<typeof setTimeout> | undefined;

function clearInFlightTimer() {
  if (inFlightTimer) {
    clearTimeout(inFlightTimer);
    inFlightTimer = undefined;
  }
}

export const forceSyncGithubAtom = atom(null, async (get, set) => {
  if (get(githubSyncInFlightAtom)) return;
  set(githubSyncInFlightAtom, true);
  try {
    await forceSyncGithub();
    clearInFlightTimer();
    // A near-instant sync can fire the completion event during the await above, clearing the
    // flag before we get here; only arm the backstop while we're still genuinely waiting.
    if (get(githubSyncInFlightAtom)) {
      inFlightTimer = setTimeout(
        () => set(githubSyncInFlightAtom, false),
        GITHUB_SYNC_INFLIGHT_TIMEOUT_MS,
      );
    }
  } catch (e) {
    clearInFlightTimer();
    set(githubSyncInFlightAtom, false);
    pushErrorToast(e instanceof Error ? e.message : String(e));
  }
});

// App-lifetime owner for GitHub sync state. A single github-sync-completed listener (module init,
// not a React effect, so StrictMode can't double-register) refreshes the cache, records the
// timestamp the header reads, clears the in-flight flag, and toasts.
export function initGithubSync(): void {
  const store = getDefaultStore();
  store.sub(activeSpaceAtom, () => {
    if (store.get(activeSpaceAtom) !== "work-board") return;
    if (store.get(githubSyncInFlightAtom)) return;
    // Call the backend directly instead of going through the atom — the atom's catch path
    // shows an error toast, which is appropriate for manual cmd+r but not for an automatic
    // navigation trigger (an unauthenticated install would toast on every board visit).
    forceSyncGithub().catch(() => {});
  });

  void onGithubSyncCompleted(() => {
    clearInFlightTimer();
    void refetchTaskSummaries(queryClient);
    store.set(githubSyncInFlightAtom, false);
    store.set(githubSyncLastSyncedAtom, Date.now());
    pushInfoToast("GitHub status refreshed");
  });
}
