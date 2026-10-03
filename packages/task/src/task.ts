import { EventPublisher } from "@orpc/server";
import type { Db, Workbench } from "@tania/workbench/server";
import type { BackgroundSyncError, TaskChange } from "./contract.ts";
import { defaultGitHub, type GitHub } from "./github.ts";
import { SYNC_TIMEOUT_MS, type SyncDeps, syncOpenTasks } from "./sync.ts";

export type Task = {
  events: EventPublisher<{ change: TaskChange }>;
  start(): void;
  stop(): void;
};

type Internals = SyncDeps & { backgroundSyncError: () => BackgroundSyncError | null };

const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60_000;

// Task の型は events / start / stop だけに保ち、GitHub への接続などの中身は Task を key にここへ置く。
const internalsOf = new WeakMap<Task, Internals>();

export function internals(task: Task): Internals {
  const found = internalsOf.get(task);
  if (!found) throw new Error("this Task was not made by createTask");
  return found;
}

export function createTask(deps: { db: Db; workbench: Workbench; github?: GitHub }): Task {
  const { db, github = defaultGitHub } = deps;
  const events = new EventPublisher<{ change: TaskChange }>();
  const stopped = new AbortController();
  const syncDeps: SyncDeps = {
    db,
    github,
    publish: (change) => events.publish("change", change),
    signal: (timeoutMs) => AbortSignal.any([AbortSignal.timeout(timeoutMs), stopped.signal]),
    running: new Map(),
  };
  let backgroundSyncError: BackgroundSyncError | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  // retry と backoff は持たず、次の回がやり直す。
  async function syncInBackground() {
    let failure: string | null;
    try {
      const { missing, failures } = await syncOpenTasks(syncDeps, SYNC_TIMEOUT_MS);
      if (missing.length > 0) console.error(`[task] GitHub did not return ${missing.join(", ")}`);
      failure = failures.length > 0 ? failures.join("; ") : null;
    } catch (error) {
      failure = String(error);
    }
    if (stopped.signal.aborted) return;
    backgroundSyncError = failure === null ? null : { at: new Date(), message: failure };
    if (failure !== null) console.error(`[task] background sync failed: ${failure}`);
  }

  const task: Task = {
    events,
    start() {
      void syncInBackground();
      timer = setInterval(() => void syncInBackground(), BACKGROUND_SYNC_INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      stopped.abort(new Error("the Task has stopped"));
    },
  };
  internalsOf.set(task, { ...syncDeps, backgroundSyncError: () => backgroundSyncError });
  return task;
}
