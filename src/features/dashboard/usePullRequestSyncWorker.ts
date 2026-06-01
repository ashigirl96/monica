import { useEffect, useRef } from "react";
import { syncNextLinkedPullRequest } from "./api";

const SYNC_INTERVAL_MS = 10_000;

interface UsePullRequestSyncWorkerOptions {
  enabled: boolean;
  onSynced: () => void;
  onAuthRequired: () => void;
}

export function usePullRequestSyncWorker({
  enabled,
  onSynced,
  onAuthRequired,
}: UsePullRequestSyncWorkerOptions) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await syncNextLinkedPullRequest();
        if (result.status === "synced") onSynced();
        else if (result.status === "auth_required") onAuthRequired();
      } catch (e) {
        console.warn("pull request sync failed", e);
      } finally {
        inFlight.current = false;
      }
    };

    const id = window.setInterval(() => void tick(), SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, onSynced, onAuthRequired]);
}
