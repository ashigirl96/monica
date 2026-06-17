import { onTaskRunStatusChanged } from "@/commands/task";
import { onPrSyncCompleted } from "@/commands/pull_request";
import { queryClient } from "@/stores/query-client";
import { isTaskSummaryKey, queryKeys } from "@/stores/query-keys";
import { pushErrorToast, pushInfoToast } from "@/stores/toast";

const POLL_INTERVAL_MS = 3000;

// App-lifetime owner for backend-driven query freshness. A single listener/interval per
// signal, rather than one per mounted component. Module init (not a React effect) so it
// runs once and StrictMode can't double-register.
export function initQuerySync(): void {
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.summaryFamily() });

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

  // Surface only a failed first load (empty board). data === undefined excludes refetch
  // failures that keep stale data (the error reducer flips status to "error" either way);
  // fetchStatus === "idle" waits until retries are exhausted, not the in-flight attempts.
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      isTaskSummaryKey(event.query.queryKey) &&
      event.query.state.status === "error" &&
      event.query.state.data === undefined &&
      event.query.state.fetchStatus === "idle"
    ) {
      pushErrorToast("Failed to refresh tasks");
    }
  });
}
