import { useCallback, useEffect, useRef, useState } from "react";
import { listTaskSummaries, listTasks } from "./api";
import { STATUS_META } from "./statusMeta";
import type { TaskSummaryRow, Task, TaskView } from "./types";

const POLL_MS = 3000;

function merge(items: Task[], statuses: TaskSummaryRow[]): TaskView[] {
  const byId = new Map<string, TaskSummaryRow>();
  for (const s of statuses) byId.set(s.id, s);
  return items
    .map((item) => {
      const s = byId.get(item.id);
      return {
        ...item,
        status: s?.status ?? item.status,
        task_status: s?.task_status ?? item.status,
        task_run_status: s?.task_run_status ?? null,
        task_run_wait_reason: s?.task_run_wait_reason ?? null,
        project: s?.project ?? item.project_id ?? null,
        githubIssueNumber: s?.github_issue_number ?? null,
        githubPullRequests: s?.github_pull_requests ?? [],
        branch: s?.branch ?? null,
      } satisfies TaskView;
    })
    .sort((a, b) => {
      const o = STATUS_META[a.status].order - STATUS_META[b.status].order;
      if (o !== 0) return o;
      return b.updated_at.localeCompare(a.updated_at);
    });
}

export interface UseTasks {
  items: TaskView[];
  loading: boolean;
  error: string | null;
  lastSync: Date | null;
  refresh: () => void;
}

export function useTasks(): UseTasks {
  const [items, setItems] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [tasks, statuses] = await Promise.all([listTasks(), listTaskSummaries()]);
      setItems(merge(tasks, statuses));
      setError(null);
      setLastSync(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const refresh = useCallback(() => void load(), [load]);

  return { items, loading, error, lastSync, refresh };
}
