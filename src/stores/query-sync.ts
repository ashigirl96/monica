import { onTaskRunStatusChanged } from "@/commands/task";
import { onPrSyncCompleted } from "@/commands/pull_request";
import { queryClient } from "@/stores/query-client";
import { invalidateTaskSummaries, isTaskSummaryKey } from "@/stores/query-keys";
import { pushErrorToast, pushInfoToast } from "@/stores/toast";

const POLL_INTERVAL_MS = 3000;

// App-lifetime owner for backend-driven query freshness. A single listener/interval per
// signal, rather than one per mounted component. Module init (not a React effect) so it
// runs once and StrictMode can't double-register.
export function initQuerySync(): void {
  const invalidate = () => void invalidateTaskSummaries(queryClient);

  void onTaskRunStatusChanged(invalidate);
  void onPrSyncCompleted(() => {
    invalidate();
    pushInfoToast("PR status refreshed");
  });

  // The hook CLI writes task-run status straight to the DB without a Tauri event, so a
  // poll backs up the listener. document.hidden gates it so a backgrounded window idles.
  setInterval(() => {
    if (!document.hidden) invalidate();
  }, POLL_INTERVAL_MS);

  // Surface only the first failed load (empty board): once shown, stay quiet until a successful
  // load resets it, instead of re-toasting on every failed poll. data === undefined excludes
  // refetch failures that keep stale data (the error reducer flips status to "error" either way);
  // fetchStatus === "idle" waits until retries are exhausted, not the in-flight attempts.
  let taskLoadErrorShown = false;
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || !isTaskSummaryKey(event.query.queryKey)) return;
    const state = event.query.state;
    if (state.status === "error" && state.data === undefined && state.fetchStatus === "idle") {
      if (!taskLoadErrorShown) {
        taskLoadErrorShown = true;
        pushErrorToast("Failed to refresh tasks");
      }
    } else if (state.status === "success") {
      taskLoadErrorShown = false;
    }
  });
}
