import { useEffect, useRef } from "react";
import { syncNextLinkedPullRequest } from "./api";

const SYNC_INTERVAL_MS = 10_000;

interface UsePullRequestSyncWorkerOptions {
  enabled: boolean;
  onSynced: () => void;
}

export function usePullRequestSyncWorker({ enabled, onSynced }: UsePullRequestSyncWorkerOptions) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await syncNextLinkedPullRequest();
        if (result.status === "synced") onSynced();
      } catch (e) {
        console.warn("pull request sync failed", e);
      } finally {
        inFlight.current = false;
      }
    };

    const id = window.setInterval(() => void tick(), SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, onSynced]);
}
