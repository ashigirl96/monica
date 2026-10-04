import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ORPCError } from "@orpc/server";
import { tab } from "@tania/workbench/schema";
import type { Db, Workbench } from "@tania/workbench/server";
import type { Subprocess } from "bun";
import { asc, eq } from "drizzle-orm";
import type { BenchItem, CurrentOutput, RunOutput, TaskChange } from "./contract.ts";
import { isIssue } from "./copy.ts";
import { displayState } from "./display-state.ts";
import {
  branchOf,
  checkoutOf,
  type Ghq,
  messageOf,
  prepare,
  setupLogOf,
  worktreeOf,
} from "./prepare.ts";
import { formatRef, parseRef } from "./ref.ts";
import { bench, issue, task } from "./schema.ts";

export type BenchDeps = {
  db: Db;
  workbench: Workbench;
  home: string;
  ghq: Ghq;
  publish: (change: TaskChange) => void;
  stopped: AbortSignal;
  preparations: Map<number, Promise<Prepared>>;
  setups: Set<Subprocess>;
};

type Prepared = { warnings: string[] } | { error: string };
type Bench = typeof bench.$inferSelect;
type Issue = typeof issue.$inferSelect;

const INTERRUPTED = "the Backend stopped while preparing";

export async function runTask(
  deps: BenchDeps,
  input: { ref: string; inPlace?: boolean },
): Promise<RunOutput> {
  const asked = parseRef(input.ref);
  const found = deps.db
    .select({ task, issue, bench })
    .from(task)
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(isIssue(asked))
    .get();
  if (!found) throw new ORPCError("NOT_FOUND", { message: `${formatRef(asked)} is not tracked` });
  const ref = formatRef(found.issue);
  if (found.task.closedAt) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${ref} is closed, so run \`tania task reopen ${ref}\``,
    });
  }
  const mode = input.inPlace ? "in_place" : "worktree";
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
  if (input.inPlace && opened.bench.mode !== "in_place") {
    throw new ORPCError("BAD_REQUEST", {
      message: `the Bench of ${ref} is a worktree; close and reopen ${ref} to open it in place`,
    });
  }
  const prepared = await preparation(deps, opened.bench, found.issue);
  if ("error" in prepared) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `could not prepare the Bench of ${ref}: ${prepared.error}; see ${setupLogOf(deps.home, found.issue)}`,
    });
  }
  return {
    ref,
    cwd: opened.bench.cwd,
    mode: opened.bench.mode,
    benchCreated: opened.created,
    warnings: prepared.warnings,
  };
}

export function currentTask(db: Db, terminalSessionId: string | undefined): CurrentOutput {
  if (!terminalSessionId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "not in a Tab of the Workbench: TANIA_TERMINAL_SESSION_ID is not set",
    });
  }
  const found = db
    .select({ task, issue, bench })
    .from(tab)
    .innerJoin(bench, eq(bench.runspaceId, tab.runspaceId))
    .innerJoin(task, eq(task.issueId, bench.taskIssueId))
    .innerJoin(issue, eq(issue.id, task.issueId))
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get();
  if (!found) {
    throw new ORPCError("NOT_FOUND", {
      message: `the Tab of Terminal Session ${terminalSessionId} is not in a Bench`,
    });
  }
  return {
    ref: formatRef(found.issue),
    title: found.issue.title,
    displayState: displayState(found.task, found.issue, found.bench),
    agentSessionId: null,
    source: "bench",
  };
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
    const existing = tx.select().from(bench).where(eq(bench.taskIssueId, forIssue.id)).get();
    if (existing) return { bench: existing, created: false };
    const runspaceId = deps.workbench.createRunspace(tx, { cwd });
    const created = tx
      .insert(bench)
      .values({
        taskIssueId: forIssue.id,
        runspaceId,
        cwd,
        mode,
        branch: mode === "worktree" ? branchOf(forIssue) : null,
        setupState: "preparing",
        createdAt: new Date(),
      })
      .returning()
      .get();
    return { bench: created, created: true };
  });
  if (opened.created) deps.publish({ type: "task", ref: formatRef(forIssue) });
  return opened;
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
