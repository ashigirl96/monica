import { ORPCError, type ORPCErrorConstructorMap } from "@orpc/server";
import { agentSession, runspace } from "@tania/workbench/schema";
import type { Db } from "@tania/workbench/server";
import { and, eq, ne, type SQL } from "drizzle-orm";
import { type BenchDeps, type Issue, refuseClosing } from "./bench.ts";
import type { CloseOutput, CloseRefusal, closeErrors, ReopenOutput } from "./contract.ts";
import { isIssue } from "./copy.ts";
import { findTrackedTask } from "./open-task.ts";
import { messageOf } from "./prepare.ts";
import { formatRef, parseRef } from "./ref.ts";
import { liveAgentSession } from "./run.ts";
import { bench, issue, run, task } from "./schema.ts";
import { type SyncDeps, syncOrUseCopy } from "./sync.ts";
import { inspectWorktree, removeWorktree } from "./teardown.ts";

export async function closeTask(
  deps: SyncDeps & BenchDeps,
  input: { ref: string; force?: boolean; terminalSessionId?: string },
  errors: ORPCErrorConstructorMap<typeof closeErrors>,
): Promise<CloseOutput> {
  const asked = parseRef(input.ref);
  const tracked = openTaskToClose(deps.db, isIssue(asked), formatRef(asked));
  reserveForClose(deps, tracked.issue.id, formatRef(tracked.issue));
  try {
    return await closeReserved(deps, tracked.issue, input, errors);
  } finally {
    deps.closing.delete(tracked.issue.id);
  }
}

// 予約の間は準備も Tab も Bench に入らないので、Bench の行は git を待つ間も変わらない。
async function closeReserved(
  deps: SyncDeps & BenchDeps,
  tracked: Issue,
  input: { force?: boolean; terminalSessionId?: string },
  errors: ORPCErrorConstructorMap<typeof closeErrors>,
): Promise<CloseOutput> {
  const warnings = await syncOrUseCopy(deps, tracked);
  // sync は repo の改名を写すので、名前でなく行の id で引き直す。
  const found = openTaskToClose(deps.db, eq(issue.id, tracked.id), formatRef(tracked));
  const ref = formatRef(found.issue);
  const benchRow = found.bench;
  const worktree =
    benchRow?.mode === "worktree"
      ? await stopOnGitFailure(ref, () => inspectWorktree(deps.ghq, benchRow, found.issue))
      : null;
  if (!input.force) {
    const reasons = [
      ...liveRunsBesides(deps.db, found.issue.id, input.terminalSessionId),
      ...(worktree?.refusals ?? []),
    ];
    if (reasons.length > 0) {
      throw errors.CLOSE_REFUSED({
        message: refusalMessage(ref, reasons, benchRow?.cwd),
        data: { reasons },
      });
    }
  }
  const removed = worktree
    ? await stopOnGitFailure(ref, () => removeWorktree(worktree))
    : { removedWorktree: null, deletedBranch: null };
  const closed = deps.db.transaction((tx) => {
    const now = openTaskToClose(tx, eq(issue.id, found.issue.id), ref);
    const closedRef = formatRef(now.issue);
    tx.update(task).set({ closedAt: new Date() }).where(eq(task.issueId, found.issue.id)).run();
    if (!now.bench) return { ref: closedRef, spared: false, terminalSessionIds: [] };
    tx.delete(bench).where(eq(bench.taskIssueId, found.issue.id)).run();
    const { runspaceId } = now.bench;
    const terminalSessionIds = deps.workbench.removeRunspace(tx, runspaceId, {
      spare: input.terminalSessionId,
    });
    const spared =
      tx.select({ id: runspace.id }).from(runspace).where(eq(runspace.id, runspaceId)).get() !==
      undefined;
    return { ref: closedRef, spared, terminalSessionIds };
  });
  deps.publish({ type: "task", ref: closed.ref });
  await deps.workbench.terminateTerminalSessions(closed.terminalSessionIds);
  return { ref: closed.ref, ...removed, spared: closed.spared, warnings };
}

export async function reopenTask(
  deps: SyncDeps & Pick<BenchDeps, "closing">,
  input: { ref: string },
): Promise<ReopenOutput> {
  const asked = parseRef(input.ref);
  const tracked = closedTask(deps.db, isIssue(asked), formatRef(asked));
  const warnings = await syncOrUseCopy(deps, tracked.issue);
  const reopened = deps.db.transaction((tx) => {
    const found = closedTask(tx, eq(issue.id, tracked.issue.id), formatRef(tracked.issue));
    // close は commit の後も Terminal Session を終わらせ終えるまで予約を持ち、閉じた結果を返す。
    refuseClosing(deps, found.issue.id, formatRef(found.issue));
    tx.update(task).set({ closedAt: null }).where(eq(task.issueId, found.issue.id)).run();
    return found.issue;
  });
  const ref = formatRef(reopened);
  deps.publish({ type: "task", ref });
  return { ref, title: reopened.title, warnings };
}

function openTaskToClose(db: Pick<Db, "select">, where: SQL | undefined, asked: string) {
  const found = findTrackedTask(db, where, asked);
  const ref = formatRef(found.issue);
  if (found.task.closedAt) {
    throw new ORPCError("BAD_REQUEST", { message: `${ref} is already closed` });
  }
  return found;
}

// 準備は worktree と Bench の行を書き続けるので、走っている間は片付けない。
function reserveForClose(deps: BenchDeps, taskIssueId: number, ref: string) {
  refuseClosing(deps, taskIssueId, ref);
  if (deps.preparations.has(taskIssueId)) {
    throw new ORPCError("CONFLICT", {
      message: `the Bench of ${ref} is being prepared; close it once the setup ends, or times out after 600s`,
    });
  }
  deps.closing.add(taskIssueId);
}

function closedTask(db: Pick<Db, "select">, where: SQL | undefined, asked: string) {
  const found = findTrackedTask(db, where, asked);
  if (!found.task.closedAt) {
    throw new ORPCError("BAD_REQUEST", { message: `${formatRef(found.issue)} is open` });
  }
  return found;
}

// close を頼んだ agent の Run は、close の後も呼び手の Tab に残るので止めない。
function liveRunsBesides(db: Db, taskIssueId: number, caller: string | undefined): CloseRefusal[] {
  return db
    .select({ agentSessionId: agentSession.sessionId, state: agentSession.state })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(
      and(
        eq(run.taskIssueId, taskIssueId),
        liveAgentSession,
        caller === undefined ? undefined : ne(agentSession.terminalSessionId, caller),
      ),
    )
    .orderBy(run.id)
    .all()
    .flatMap(({ agentSessionId, state }) =>
      state === "ended" ? [] : [{ kind: "active_run" as const, agentSessionId, state }],
    );
}

async function stopOnGitFailure<T>(ref: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: `could not close ${ref}: ${messageOf(error)}`,
    });
  }
}

function refusalMessage(ref: string, reasons: CloseRefusal[], worktree: string | undefined) {
  const lines = reasons.map((reason) => {
    switch (reason.kind) {
      case "active_run":
        return `claude ${reason.agentSessionId} is a live Run (${reason.state})`;
      case "uncommitted_changes":
        return `the worktree ${worktree} has uncommitted changes`;
      case "unpublished_commits":
        return `branch ${reason.branch} has commits on no remote`;
    }
  });
  return [`${ref} stays open:`, ...lines, "pass --force to close anyway"].join("\n");
}
