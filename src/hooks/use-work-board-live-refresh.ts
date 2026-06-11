import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { onTaskRunStatusChanged } from "@/commands/task";
import { onPrSyncCompleted } from "@/commands/pull_request";
import { refreshTaskSummariesAtom } from "@/stores/workboard";
import { pushInfoToast } from "@/stores/toast";

export function useWorkBoardLiveRefresh() {
  const refreshSummaries = useSetAtom(refreshTaskSummariesAtom);

  useEffect(() => {
    const unlisten = onTaskRunStatusChanged(() => {
      refreshSummaries();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshSummaries]);

  useEffect(() => {
    const unlisten = onPrSyncCompleted(() => {
      void refreshSummaries();
      pushInfoToast("PR status refreshed");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshSummaries]);

  useEffect(() => {
    // Hook CLI (separate process) writes status to the DB without emitting
    // Tauri events, so poll while the board is visible.
    const timer = setInterval(() => {
      if (!document.hidden) refreshSummaries();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshSummaries]);
}
