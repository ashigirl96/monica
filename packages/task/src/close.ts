import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'
import { agentSession, tab } from '@tania/workbench/schema'
import type { Db } from '@tania/workbench/server'
import { and, eq, ne, type SQL } from 'drizzle-orm'

import { type Bench, type BenchDeps, type Issue, refuseClosing } from './bench.ts'
import type { CloseOutput, CloseRefusal, closeErrors, ReopenOutput } from './contract.ts'
import { isIssue } from './copy.ts'
import { findTrackedTask } from './open-task.ts'
import { messageOf } from './prepare.ts'
import { formatRef, parseRef } from './ref.ts'
import { liveAgentSession } from './run.ts'
import { bench, issue, run, task } from './schema.ts'
import { type SyncDeps, syncOrUseCopy } from './sync.ts'
import { inspectWorktree, removeWorktree } from './teardown.ts'

export async function closeTask(
  deps: SyncDeps & BenchDeps,
  input: { ref: string; force?: boolean; terminalSessionId?: string },
  errors: ORPCErrorConstructorMap<typeof closeErrors>,
): Promise<CloseOutput> {
  const asked = parseRef(input.ref)
  const tracked = openTaskToClose(deps.db, isIssue(asked), formatRef(asked))
  reserveForClose(deps, tracked.issue.id, formatRef(tracked.issue))
  try {
    return await closeReserved(deps, tracked.issue, input, errors)
  } finally {
    deps.closing.delete(tracked.issue.id)
  }
}

// 予約の間は準備も Tab も Bench に入らないので、Bench の行は git を待つ間も変わらない。
async function closeReserved(
  deps: SyncDeps & BenchDeps,
  tracked: Issue,
  input: { force?: boolean; terminalSessionId?: string },
  errors: ORPCErrorConstructorMap<typeof closeErrors>,
): Promise<CloseOutput> {
  const warnings = await syncOrUseCopy(deps, tracked)
  // sync は repo の改名を写すので、名前でなく行の id で引き直す。
  const found = openTaskToClose(deps.db, eq(issue.id, tracked.id), formatRef(tracked))
  const ref = formatRef(found.issue)
  const benchRow = found.bench
  const worktree =
    benchRow?.mode === 'worktree' && !sharesCwdWithAnotherBench(deps.db, benchRow)
      ? await stopOnGitFailure(ref, () => inspectWorktree(deps.ghq, benchRow, found.issue))
      : null
  const force = input.force ?? false
  const caller = input.terminalSessionId
  if (!force) {
    const reasons = [
      ...liveRunsBesides(deps.db, found.issue.id, caller).map(asRefusal),
      ...(worktree?.refusals ?? []),
    ]
    if (reasons.length > 0) {
      throw errors.CLOSE_REFUSED({
        message: refusalMessage(ref, reasons, benchRow?.cwd),
        data: { reasons },
      })
    }
  }
  const removed = worktree
    ? await stopOnGitFailure(ref, () => removeWorktree(worktree, { force }))
    : { removedWorktree: null, deletedBranch: null, warnings: [] }
  const closed = deps.db.transaction((tx) => {
    const now = openTaskToClose(tx, eq(issue.id, found.issue.id), ref)
    // git を待つ間に Bench の Tab で起こした claude は hook から Run になっているので、呼び手と同じく Tab を残す。
    const lateRuns = force ? [] : liveRunsBesides(tx, found.issue.id, caller)
    tx.update(task).set({ closedAt: new Date() }).where(eq(task.issueId, found.issue.id)).run()
    let terminalSessionIds: string[] = []
    let spared = false
    if (now.bench) {
      const { runspaceId } = now.bench
      tx.delete(bench).where(eq(bench.taskIssueId, found.issue.id)).run()
      terminalSessionIds = deps.workbench.removeRunspace(tx, runspaceId, {
        spare: [...(caller ? [caller] : []), ...lateRuns.map((r) => r.terminalSessionId)],
      })
      spared = caller !== undefined && tabIn(tx, runspaceId, caller)
    }
    return { ref: formatRef(now.issue), spared, lateRuns, terminalSessionIds }
  })
  deps.publish({ type: 'task', ref: closed.ref })
  await deps.workbench.terminateTerminalSessions(closed.terminalSessionIds)
  return {
    ref: closed.ref,
    removedWorktree: removed.removedWorktree,
    deletedBranch: removed.deletedBranch,
    spared: closed.spared,
    warnings: [
      ...warnings,
      ...removed.warnings,
      ...closed.lateRuns.map(
        (r) => `claude ${r.agentSessionId} started in the Bench while closing, so its Tab stays`,
      ),
    ],
  }
}

function tabIn(db: Pick<Db, 'select'>, runspaceId: string, terminalSessionId: string): boolean {
  return (
    db
      .select({ id: tab.id })
      .from(tab)
      .where(and(eq(tab.runspaceId, runspaceId), eq(tab.terminalSessionId, terminalSessionId)))
      .get() !== undefined
  )
}

export async function reopenTask(
  deps: SyncDeps & Pick<BenchDeps, 'closing'>,
  input: { ref: string },
): Promise<ReopenOutput> {
  const asked = parseRef(input.ref)
  const tracked = closedTask(deps.db, isIssue(asked), formatRef(asked))
  const warnings = await syncOrUseCopy(deps, tracked.issue)
  const reopened = deps.db.transaction((tx) => {
    const found = closedTask(tx, eq(issue.id, tracked.issue.id), formatRef(tracked.issue))
    // close は commit の後も Terminal Session を終わらせ終えるまで予約を持ち、閉じた結果を返す。
    refuseClosing(deps, found.issue.id, formatRef(found.issue))
    tx.update(task).set({ closedAt: null }).where(eq(task.issueId, found.issue.id)).run()
    return found.issue
  })
  const ref = formatRef(reopened)
  deps.publish({ type: 'task', ref })
  return { ref, title: reopened.title, warnings }
}

function openTaskToClose(db: Pick<Db, 'select'>, where: SQL | undefined, asked: string) {
  const found = findTrackedTask(db, where, asked)
  const ref = formatRef(found.issue)
  if (found.task.closedAt) {
    throw new ORPCError('BAD_REQUEST', { message: `${ref} is already closed` })
  }
  return found
}

// repo の改名の後に旧名を別の repo が使うと、その Task の Bench が同じ path に worktree を作る。
function sharesCwdWithAnotherBench(
  db: Pick<Db, 'select'>,
  row: Pick<Bench, 'cwd' | 'taskIssueId'>,
) {
  return (
    db
      .select({ taskIssueId: bench.taskIssueId })
      .from(bench)
      .where(and(eq(bench.cwd, row.cwd), ne(bench.taskIssueId, row.taskIssueId)))
      .get() !== undefined
  )
}

// 準備は worktree と Bench の行を書き続けるので、走っている間は片付けない。
function reserveForClose(deps: BenchDeps, taskIssueId: number, ref: string) {
  refuseClosing(deps, taskIssueId, ref)
  if (deps.preparations.has(taskIssueId)) {
    throw new ORPCError('CONFLICT', {
      message: `the Bench of ${ref} is being prepared; close it once the setup ends, or times out after 600s`,
    })
  }
  deps.closing.add(taskIssueId)
}

function closedTask(db: Pick<Db, 'select'>, where: SQL | undefined, asked: string) {
  const found = findTrackedTask(db, where, asked)
  if (!found.task.closedAt) {
    throw new ORPCError('BAD_REQUEST', { message: `${formatRef(found.issue)} is open` })
  }
  return found
}

// close を頼んだ agent の Run は、close の後も呼び手の Tab に残るので止めない。
function liveRunsBesides(db: Pick<Db, 'select'>, taskIssueId: number, caller: string | undefined) {
  return db
    .select({
      agentSessionId: agentSession.sessionId,
      state: agentSession.state,
      terminalSessionId: agentSession.terminalSessionId,
    })
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
    .flatMap((row) => (row.state === 'ended' ? [] : [{ ...row, state: row.state }]))
}

function asRefusal({
  agentSessionId,
  state,
}: ReturnType<typeof liveRunsBesides>[number]): CloseRefusal {
  return { kind: 'active_run', agentSessionId, state }
}

async function stopOnGitFailure<T>(ref: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: `could not close ${ref}: ${messageOf(error)}`,
    })
  }
}

function refusalMessage(ref: string, reasons: CloseRefusal[], worktree: string | undefined) {
  const lines = reasons.map((reason) => {
    switch (reason.kind) {
      case 'active_run':
        return `claude ${reason.agentSessionId} is a live Run (${reason.state})`
      case 'uncommitted_changes':
        return `the worktree ${worktree} has uncommitted changes`
      case 'unpublished_commits':
        return `branch ${reason.branch} has commits on no remote`
    }
  })
  return [`${ref} stays open:`, ...lines, 'pass --force to close anyway'].join('\n')
}
