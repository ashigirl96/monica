import { useEffect } from "react";
import { onTaskRunStatusChanged } from "@/commands/task";

// The hook CLI (separate process) writes task-run status straight to the DB
// without emitting Tauri events, so a visible-only poll backs up the
// task-run:status-changed listener.
export function useLiveRefresh(callback: () => void, intervalMs = 3000) {
  useEffect(() => {
    callback();
    const unlisten = onTaskRunStatusChanged(() => callback());
    const timer = setInterval(() => {
      if (!document.hidden) callback();
    }, intervalMs);
    return () => {
      clearInterval(timer);
      unlisten.then((fn) => fn());
    };
  }, [callback, intervalMs]);
}
