import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { onTaskRunStatusChanged } from "@/commands/task";
import { refreshTaskSummariesAtom } from "@/stores/workboard";

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
    // Hook CLI (separate process) writes status to the DB without emitting
    // Tauri events, so poll while the board is visible.
    const timer = setInterval(() => {
      if (!document.hidden) refreshSummaries();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshSummaries]);
}
