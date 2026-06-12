import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { onPrSyncCompleted } from "@/commands/pull_request";
import { refreshTaskSummariesAtom } from "@/stores/workboard";
import { pushInfoToast } from "@/stores/toast";
import { useLiveRefresh } from "@/hooks/use-live-refresh";

export function useWorkBoardLiveRefresh() {
  const refreshSummaries = useSetAtom(refreshTaskSummariesAtom);

  useLiveRefresh(refreshSummaries);

  useEffect(() => {
    const unlisten = onPrSyncCompleted(() => {
      void refreshSummaries();
      pushInfoToast("PR status refreshed");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshSummaries]);
}
