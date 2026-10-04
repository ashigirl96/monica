import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ORPCError } from "@orpc/server";
import type { Db, Tx, Workbench } from "@tania/workbench/server";
import type { Subprocess } from "bun";
import { asc, eq } from "drizzle-orm";
import type { BenchItem, TaskChange } from "./contract.ts";
import {
  branchOf,
  checkoutOf,
  type Ghq,
  messageOf,
  prepare,
  setupLogOf,
  worktreeOf,
} from "./prepare.ts";
import { findOpenTask } from "./open-task.ts";
import { formatRef } from "./ref.ts";
import { bench, issue } from "./schema.ts";

export type BenchDeps = {
  db: Db;
  workbench: Workbench;
  home: string;
  ghq: Ghq;
  publish: (change: TaskChange) => void;
  stopped: AbortSignal;
  preparations: Map<number, Promise<Prepared>>;
  setups: Set<Subprocess>;
  /** close の途中の Task。git を待つ間に、準備や Tab が片付ける Bench に入らないようにする。 */
  closing: Set<number>;
};

type Prepared = { warnings: string[] } | { error: string };
export type Bench = typeof bench.$inferSelect;
export type Issue = typeof issue.$inferSelect;

const INTERRUPTED = "the Backend stopped while preparing";

export async function prepareBench(
  deps: BenchDeps,
  found: { issue: Issue; bench: Bench | null },
  inPlace: boolean | undefined,
): Promise<{ bench: Bench; created: boolean; warnings: string[] }> {
  const ref = formatRef(found.issue);
  const mode = inPlace ? "in_place" : "worktree";
  const cwd =
    found.bench?.cwd ??
    (mode === "in_place"
      ? await checkoutOf(deps.ghq, found.issue.repo).catch((error: unknown) => {
          throw new ORPCError("PRECONDITION_FAILED", {
            message: `could not find the checkout of ${ref}: ${messageOf(error)}`,
          });
        })
      : worktreeOf(deps.home, found.issue));
  // 待つ間に別の run が Bench を作っていれば、そちらを使う。
  const opened = openBench(deps, found.issue, { cwd, mode });
  refuseInPlace(opened.bench, inPlace, ref);
  const prepared = await preparation(deps, opened.bench, found.issue);
  if ("error" in prepared) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `could not prepare the Bench of ${ref}: ${prepared.error}; see ${setupLogOf(deps.home, found.issue)}`,
    });
  }
  return { bench: opened.bench, created: opened.created, warnings: prepared.warnings };
}

export function refuseClosing(deps: Pick<BenchDeps, "closing">, taskIssueId: number, ref: string) {
  if (deps.closing.has(taskIssueId)) {
    throw new ORPCError("CONFLICT", { message: `${ref} is being closed` });
  }
}

export function refuseInPlace(row: Bench, inPlace: boolean | undefined, ref: string) {
  if (inPlace && row.mode !== "in_place") {
    throw new ORPCError("BAD_REQUEST", {
      message: `the Bench of ${ref} is a worktree; close and reopen ${ref} to open it in place`,
    });
  }
}

export function listBenches(db: Db): BenchItem[] {
  return db
    .select({ bench, issue })
    .from(bench)
    .innerJoin(issue, eq(issue.id, bench.taskIssueId))
    .orderBy(asc(bench.createdAt))
    .all()
    .map((row) => ({
      runspaceId: row.bench.runspaceId,
      ref: formatRef(row.issue),
      title: row.issue.title,
      setupState: row.bench.setupState,
    }));
}

// 準備は Backend の中でしか進まないので、止まった Backend が残した preparing は二度と終わらない。
export function failInterruptedPreparations(db: Db) {
  db.update(bench)
    .set({ setupState: "failed", setupError: INTERRUPTED })
    .where(eq(bench.setupState, "preparing"))
    .run();
}

function openBench(
  deps: BenchDeps,
  forIssue: Issue,
  { cwd, mode }: Pick<Bench, "cwd" | "mode">,
): { bench: Bench; created: boolean } {
  const opened = deps.db.transaction((tx) => {
    // ghq root を待つ間に close が走り終えていれば、Task はもう閉じている。
    findOpenTask(tx, eq(issue.id, forIssue.id), formatRef(forIssue));
    refuseClosing(deps, forIssue.id, formatRef(forIssue));
    const existing = tx.select().from(bench).where(eq(bench.taskIssueId, forIssue.id)).get();
    if (existing) return { bench: existing, created: false };
    return {
      bench: insertBench(tx, deps.workbench, forIssue, { cwd, mode, setupState: "preparing" }),
      created: true,
    };
  });
  if (opened.created) deps.publish({ type: "task", ref: formatRef(forIssue) });
  return opened;
}

export function insertBench(
  tx: Tx,
  workbench: Workbench,
  forIssue: Issue,
  { cwd, mode, setupState }: Pick<Bench, "cwd" | "mode" | "setupState">,
): Bench {
  const createdAt = new Date();
  return tx
    .insert(bench)
    .values({
      taskIssueId: forIssue.id,
      runspaceId: workbench.createRunspace(tx, { cwd }),
      cwd,
      mode,
      branch: mode === "worktree" ? branchOf(forIssue) : null,
      setupState,
      createdAt,
      preparedAt: setupState === "ready" ? createdAt : null,
    })
    .returning()
    .get();
}

// 準備中の Bench に来た run は同じ準備を待つ。呼び手が切れても準備は Backend の中で続く。
function preparation(deps: BenchDeps, row: Bench, forIssue: Issue): Promise<Prepared> {
  const running = deps.preparations.get(row.taskIssueId);
  if (running) return running;
  if (row.setupState === "ready") return Promise.resolve({ warnings: [] });
  if (row.setupState === "failed") {
    deps.db
      .update(bench)
      .set({ setupState: "preparing", setupError: null })
      .where(eq(bench.taskIssueId, row.taskIssueId))
      .run();
    deps.publish({ type: "task", ref: formatRef(forIssue) });
  }
  const started = prepareAndRecord(deps, row, forIssue).finally(() =>
    deps.preparations.delete(row.taskIssueId),
  );
  deps.preparations.set(row.taskIssueId, started);
  return started;
}

async function prepareAndRecord(deps: BenchDeps, row: Bench, forIssue: Issue): Promise<Prepared> {
  const log = setupLogOf(deps.home, forIssue);
  let prepared: Prepared;
  try {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "");
    prepared = { warnings: await prepare(deps, forIssue, row, log) };
  } catch (error) {
    prepared = { error: messageOf(error) };
    try {
      appendFileSync(log, `tania: ${prepared.error}\n`);
    } catch {
      // log が書けなくても、理由は setup_error に残る。
    }
  }
  // stop() の後は DB が閉じているかもしれない。preparing の行は次の start() が失敗にする。
  if (deps.stopped.aborted) return { error: INTERRUPTED };
  deps.db
    .update(bench)
    .set(
      "error" in prepared
        ? { setupState: "failed", setupError: prepared.error }
        : { setupState: "ready", preparedAt: new Date() },
    )
    .where(eq(bench.taskIssueId, row.taskIssueId))
    .run();
  deps.publish({ type: "task", ref: formatRef(forIssue) });
  return prepared;
}
