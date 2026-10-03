import { ORPCError } from "@orpc/server";
import type { Db } from "@tania/workbench/server";
import { eq, isNull } from "drizzle-orm";
import type { SyncOutput, TaskChange, TrackOutput } from "./contract.ts";
import { isIssue, writeIssue } from "./copy.ts";
import { BATCH, type GitHub, oneLine, queryIssues, RepositoryNotFound } from "./github.ts";
import { formatRef, type IssueRef, parseRef } from "./ref.ts";
import { issue, task } from "./schema.ts";

export const SYNC_TIMEOUT_MS = 30_000;

export type SyncDeps = {
  db: Db;
  github: GitHub;
  publish: (change: TaskChange) => void;
  signal: (timeoutMs: number) => AbortSignal;
  running: Map<string, Promise<SyncOutcome>>;
};

/** `failures` は `owner/repo: 理由` の並び。token が取れなければ理由だけの 1 つになる。 */
export type SyncOutcome = { synced: number; missing: string[]; failures: string[] };

export async function trackIssue(deps: SyncDeps, input: string): Promise<TrackOutput> {
  const ref = parseRef(input);
  const tracked = findTask(deps.db, ref);
  const outcome = tracked
    ? await syncTask(deps, tracked, SYNC_TIMEOUT_MS)
    : await syncRefs(deps, [ref], SYNC_TIMEOUT_MS, { track: true });
  outputOrThrow(outcome, { missingIsNotFound: true });
  const row = findTask(deps.db, ref)!;
  if (!tracked) deps.publish({ type: "task", ref: formatRef(row) });
  return {
    ref: formatRef(row),
    title: row.title,
    alreadyTracked: tracked !== undefined,
    closed: row.closedAt !== null,
  };
}

export async function syncCommand(deps: SyncDeps, input: string | undefined): Promise<SyncOutput> {
  if (input === undefined) return outputOrThrow(await syncOpenTasks(deps, SYNC_TIMEOUT_MS));
  const ref = parseRef(input);
  const tracked = findTask(deps.db, ref);
  if (!tracked) throw new ORPCError("NOT_FOUND", { message: `${formatRef(ref)} is not tracked` });
  return outputOrThrow(await syncTask(deps, tracked, SYNC_TIMEOUT_MS));
}

export function syncOpenTasks(deps: SyncDeps, timeoutMs: number): Promise<SyncOutcome> {
  return joinRunning(deps, "open", timeoutMs, async () => {
    const refs = deps.db
      .select({ repo: issue.repo, number: issue.number })
      .from(task)
      .innerJoin(issue, eq(issue.id, task.issueId))
      .where(isNull(task.closedAt))
      .all();
    const outcome = await syncRefs(deps, refs, timeoutMs);
    if (outcome.synced > 0) deps.publish({ type: "synced" });
    return outcome;
  });
}

// closed な Task も引く。run / close / reopen の直前の sync は失敗しても手元の写しで続けるので、投げずに返す。
export function syncTask(deps: SyncDeps, ref: IssueRef, timeoutMs: number): Promise<SyncOutcome> {
  return joinRunning(deps, `task:${formatRef(ref).toLowerCase()}`, timeoutMs, async () => {
    const outcome = await syncRefs(deps, [ref], timeoutMs);
    if (outcome.synced > 0) deps.publish({ type: "task", ref: formatRef(ref) });
    return outcome;
  });
}

// 後から来た呼び手は、走っている sync の timeout ではなく自分の timeout まで待つ。
function joinRunning(
  deps: SyncDeps,
  scope: string,
  timeoutMs: number,
  run: () => Promise<SyncOutcome>,
): Promise<SyncOutcome> {
  const running = deps.running.get(scope);
  if (running) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<SyncOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ synced: 0, missing: [], failures: [timedOutAfter(timeoutMs)] }),
        timeoutMs,
      );
    });
    return Promise.race([running, timedOut]).finally(() => clearTimeout(timer));
  }
  const started = run().finally(() => deps.running.delete(scope));
  deps.running.set(scope, started);
  return started;
}

function findTask(db: Db, ref: IssueRef) {
  return db
    .select({
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      closedAt: task.closedAt,
    })
    .from(task)
    .innerJoin(issue, eq(issue.id, task.issueId))
    .where(isIssue(ref))
    .get();
}

/**
 * 1 つの repo が失敗しても他の repo は書く。`track` は写しと同じ transaction で Task の行を足すので、
 * 失敗か missing なら何も書かない。
 */
async function syncRefs(
  deps: SyncDeps,
  refs: IssueRef[],
  timeoutMs: number,
  { track = false } = {},
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { synced: 0, missing: [], failures: [] };
  if (refs.length === 0) return outcome;
  const signal = deps.signal(timeoutMs);
  const reason = (error: unknown) =>
    signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? timedOutAfter(timeoutMs)
      : oneLine(error instanceof Error ? error.message : String(error));
  let token: string;
  try {
    token = await deps.github.token(signal);
  } catch (error) {
    outcome.failures.push(reason(error));
    return outcome;
  }
  await Promise.all(
    byRepo(refs).map(async ([repo, numbers]) => {
      try {
        for (let i = 0; i < numbers.length; i += BATCH) {
          const answer = await queryIssues(
            { url: deps.github.url, token },
            repo,
            numbers.slice(i, i + BATCH),
            signal,
          );
          const syncedAt = new Date();
          deps.db.transaction((tx) => {
            for (const copied of answer.issues) {
              const issueId = writeIssue(tx, copied, syncedAt);
              if (track) {
                tx.insert(task)
                  .values({ issueId, trackedAt: syncedAt })
                  .onConflictDoNothing()
                  .run();
              }
            }
          });
          outcome.synced += answer.issues.length;
          outcome.missing.push(...answer.missing.map(formatRef));
        }
      } catch (error) {
        // 打ち間違えた repo を track したときに、GitHub の障害に見せない。
        if (track && error instanceof RepositoryNotFound) {
          outcome.missing.push(...numbers.map((number) => formatRef({ repo, number })));
          return;
        }
        outcome.failures.push(`${repo}: ${reason(error)}`);
      }
    }),
  );
  outcome.missing.sort();
  outcome.failures.sort();
  return outcome;
}

function byRepo(refs: IssueRef[]): [string, number[]][] {
  const groups = new Map<string, [string, number[]]>();
  for (const { repo, number } of refs) {
    const key = repo.toLowerCase();
    const group = groups.get(key) ?? [repo, []];
    group[1].push(number);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function timedOutAfter(timeoutMs: number): string {
  return `timed out after ${timeoutMs / 1000}s`;
}

function outputOrThrow(
  { synced, missing, failures }: SyncOutcome,
  { missingIsNotFound = false } = {},
): SyncOutput {
  if (failures.length > 0) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `could not sync from GitHub: ${failures.join("; ")}`,
    });
  }
  if (missingIsNotFound && missing.length > 0) {
    throw new ORPCError("NOT_FOUND", { message: `GitHub has no issue ${missing.join(", ")}` });
  }
  return { synced, missing };
}
