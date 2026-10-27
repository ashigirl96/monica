import { tab } from '@monica/workbench/schema'
import type { Db } from '@monica/workbench/server'
import { ORPCError, type ORPCErrorConstructorMap } from '@orpc/server'
import { and, eq, ne } from 'drizzle-orm'

import type { Bench, BenchDeps } from './bench.ts'
import type { CloseOutput, CloseRefusal, closeErrors, ReopenOutput } from './contract.ts'
import { isIssue } from './copy.ts'
import { findTask, refreshTask } from './find-task.ts'
import type { FoundTask } from './open-task.ts'
import { messageOf } from './prepare.ts'
import { formatRef, parseRef } from './ref.ts'
import { describeRefusal } from './refusal.ts'
import { activeRunsBesides } from './run.ts'
import { bench, issue, pullRequest, task, taskPullRequest } from './schema.ts'
import type { SyncDeps } from './sync.ts'
import { inspectWorktree, removeWorktree } from './teardown.ts'
import { trashOf } from './trash.ts'

export async function closeTask(
  deps: SyncDeps & BenchDeps,
  input: { ref: string; force?: boolean; terminalSessionId?: string },
  errors: ORPCErrorConstructorMap<typeof closeErrors>,
): Promise<CloseOutput> {
  const asked = parseRef(input.ref)
  const tracked = findTask(deps.db, isIssue(asked), formatRef(asked), 'close')
  return deps.reservations.whileClosing(
    tracked.issue.id,
    formatRef(tracked.issue),
    input.force ?? false,
    () => closeReserved(deps, tracked, input, errors),
  )
}

// 予約の間は準備も Tab も Bench に入らないので、Bench の行は git を待つ間も変わらない。
async function closeReserved(
  deps: SyncDeps & BenchDeps,
  tracked: FoundTask,
  input: { force?: boolean; terminalSessionId?: string },
  errors: ORPCErrorConstructorMap<typeof closeErrors>,
): Promise<CloseOutput> {
  const { found, warnings } = await refreshTask(deps, tracked, 'close')
  const ref = formatRef(found.issue)
  const benchRow = found.bench
  const worktree =
    benchRow?.mode === 'worktree' && !sharesCwdWithAnotherBench(deps.db, benchRow)
      ? await stopOnGitFailure(ref, () =>
          inspectWorktree(
            deps.ghq,
            benchRow,
            found.issue,
            mergedBranchHeads(deps.db, found.issue.id),
          ),
        )
      : null
  const force = input.force ?? false
  const caller = input.terminalSessionId
  if (!force) {
    const reasons = [
      ...activeRunsBesides(deps.db, found.issue.id, caller).map(asRefusal),
      ...(worktree?.refusals ?? []),
    ]
    if (reasons.length > 0) {
      throw errors.CLOSE_REFUSED({
        message: refusalMessage(ref, reasons),
        data: { reasons },
      })
    }
  }
  const removed = worktree
    ? await stopOnGitFailure(ref, () =>
        removeWorktree(worktree, { force, trash: trashOf(deps.home) }),
      )
    : { removedWorktree: null, deletedBranch: null, warnings: [] }
  const closed = deps.db.transaction((tx) => {
    const now = findTask(tx, eq(issue.id, found.issue.id), ref, 'close')
    // git を待つ間に live になった Run（Bench の Tab で起こしたものと、Bench の外で resume したもの）は、呼び手と同じく Tab を残す。
    const lateRuns = force ? [] : activeRunsBesides(tx, found.issue.id, caller)
    tx.update(task).set({ closedAt: new Date() }).where(eq(task.issueId, found.issue.id)).run()
    let spared = false
    if (now.bench) {
      const { runspaceId } = now.bench
      tx.delete(bench).where(eq(bench.taskIssueId, found.issue.id)).run()
      deps.workbenchLedger.removeRunspace(tx, runspaceId, {
        spare: [...(caller ? [caller] : []), ...lateRuns.map((r) => r.terminalSessionId)],
      })
      spared = caller !== undefined && tabIn(tx, runspaceId, caller)
    }
    return { ref: formatRef(now.issue), spared, lateRuns }
  })
  deps.publish({ type: 'task', ref: closed.ref })
  return {
    ref: closed.ref,
    removedWorktree: removed.removedWorktree,
    deletedBranch: removed.deletedBranch,
    spared: closed.spared,
    warnings: [
      ...warnings,
      ...removed.warnings,
      ...closed.lateRuns.map(
        (r) => `claude ${r.agentSessionId} became a live Run while closing, so its Tab stays`,
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
  deps: SyncDeps & Pick<BenchDeps, 'reservations'>,
  input: { ref: string },
  { recheck }: { recheck?: (found: FoundTask) => void } = {},
): Promise<ReopenOutput> {
  const asked = parseRef(input.ref)
  const tracked = findTask(deps.db, isIssue(asked), formatRef(asked), 'reopen')
  // 状態は writeClosedTask が予約の後に断る。先に断ると、close の途中の reopen が CONFLICT でなく BAD_REQUEST になる。
  const { found: synced, warnings } = await refreshTask(deps, tracked)
  const reopened = deps.reservations.writeClosedTask(
    synced.issue.id,
    formatRef(synced.issue),
    (tx, found) => {
      recheck?.(found)
      tx.update(task).set({ closedAt: null }).where(eq(task.issueId, found.issue.id)).run()
      return found.issue
    },
  )
  const ref = formatRef(reopened)
  deps.publish({ type: 'task', ref })
  return { ref, title: reopened.title, warnings }
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

// closing reference だけの merged PR は別の branch の仕事なので、その head は Bench の branch の commit を守らない。
function mergedBranchHeads(db: Db, taskIssueId: number): string[] {
  return db
    .selectDistinct({ headOid: pullRequest.headOid })
    .from(taskPullRequest)
    .innerJoin(pullRequest, eq(pullRequest.id, taskPullRequest.pullRequestId))
    .where(
      and(
        eq(taskPullRequest.taskIssueId, taskIssueId),
        eq(taskPullRequest.source, 'branch'),
        eq(pullRequest.state, 'merged'),
      ),
    )
    .all()
    .map((row) => row.headOid)
}

function asRefusal({
  agentSessionId,
  state,
}: ReturnType<typeof activeRunsBesides>[number]): CloseRefusal {
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

function refusalMessage(ref: string, reasons: CloseRefusal[]) {
  const refusal = describeRefusal(ref, reasons)
  return [refusal.headline, ...refusal.reasons, 'pass --force to close anyway'].join('\n')
}
