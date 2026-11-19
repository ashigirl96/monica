import { existsSync } from 'node:fs'

import type { Db, Tx, WorkbenchLedger } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'
import { asc, eq } from 'drizzle-orm'

import type { BenchItem, TaskChange } from './contract.ts'
import {
  branchOf,
  checkoutOf,
  checkoutOfWorktree,
  clone,
  type Ghq,
  messageOf,
  worktreeOf,
} from './prepare.ts'
import { formatRef } from './ref.ts'
import type { Reservations } from './reservation.ts'
import { bench, issue } from './schema.ts'

export type BenchDeps = {
  db: Db
  workbenchLedger: WorkbenchLedger
  home: string
  ghq: Ghq
  publish: (change: TaskChange) => void
  reservations: Reservations
}

export type Bench = typeof bench.$inferSelect
export type Issue = typeof issue.$inferSelect

/** worktree は作らない。新しい Run の claude が `--worktree` で作る。 */
export async function openBenchFor(
  deps: BenchDeps,
  found: { issue: Issue; bench: Bench | null },
  inPlace: boolean | undefined,
): Promise<{ bench: Bench; created: boolean }> {
  const ref = formatRef(found.issue)
  if (found.bench) {
    refuseInPlace(found.bench, inPlace, ref)
    await cloneAgain(deps.ghq, found.bench, found.issue)
    return { bench: found.bench, created: false }
  }
  const checkout = await cloned(deps.ghq, found.issue, checkoutOf(deps.ghq, found.issue.repo))
  const opened = inPlace
    ? openBench(deps, found.issue, { cwd: checkout, mode: 'in_place' })
    : openBench(deps, found.issue, { cwd: worktreeOf(checkout, found.issue), mode: 'worktree' })
  // 待つ間に別の run が Bench を作っていれば、そちらを使う。
  refuseInPlace(opened.bench, inPlace, ref)
  return opened
}

async function cloned(ghq: Ghq, forIssue: Issue, checkout: Promise<string>): Promise<string> {
  try {
    const path = await checkout
    await clone(ghq, forIssue.repo, path)
    return path
  } catch (error) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: `could not get the checkout of ${formatRef(forIssue)}: ${messageOf(error)}`,
    })
  }
}

// claude --worktree は checkout があれば worktree を作り直すが、`.claude/worktrees` の外の worktree は誰も作り直さない。
async function cloneAgain(ghq: Ghq, row: Bench, forIssue: Issue) {
  if (existsSync(row.cwd)) return
  const checkout = row.mode === 'in_place' ? row.cwd : checkoutOfWorktree(row.cwd)
  if (checkout === null) {
    const ref = formatRef(forIssue)
    throw new ORPCError('PRECONDITION_FAILED', {
      message: `the worktree ${row.cwd} of ${ref} is gone; close and reopen ${ref} to open its Bench again`,
    })
  }
  await cloned(ghq, forIssue, Promise.resolve(checkout))
}

export function refuseInPlace(row: Bench, inPlace: boolean | undefined, ref: string) {
  if (inPlace && row.mode !== 'in_place') {
    throw new ORPCError('BAD_REQUEST', {
      message: `the Bench of ${ref} is a worktree; close and reopen ${ref} to open it in place`,
    })
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
    }))
}

function openBench(
  deps: BenchDeps,
  forIssue: Issue,
  { cwd, mode }: Pick<Bench, 'cwd' | 'mode'>,
): { bench: Bench; created: boolean } {
  // ghq root を待つ間に close が走り終えていれば、Task はもう閉じている。
  const opened = deps.reservations.writeOpenTask(forIssue.id, formatRef(forIssue), (tx) => {
    const existing = tx.select().from(bench).where(eq(bench.taskIssueId, forIssue.id)).get()
    if (existing) return { bench: existing, created: false }
    return {
      bench: insertBench(tx, deps.workbenchLedger, forIssue, { cwd, mode }),
      created: true,
    }
  })
  if (opened.created) deps.publish({ type: 'task', ref: formatRef(forIssue) })
  return opened
}

export function insertBench(
  tx: Tx,
  workbenchLedger: WorkbenchLedger,
  forIssue: Issue,
  { cwd, mode }: Pick<Bench, 'cwd' | 'mode'>,
): Bench {
  return tx
    .insert(bench)
    .values({
      taskIssueId: forIssue.id,
      runspaceId: workbenchLedger.createRunspace(tx, { cwd }),
      cwd,
      mode,
      branch: mode === 'worktree' ? branchOf(forIssue) : null,
      createdAt: new Date(),
    })
    .returning()
    .get()
}

/** `spare` の Terminal Session の Tab は所有を解いた Runspace に残し、残した Terminal Session を返す。 */
export function dropBench(
  tx: Tx,
  workbenchLedger: WorkbenchLedger,
  row: Pick<Bench, 'taskIssueId' | 'runspaceId'>,
  { spare }: { spare: string[] },
): string[] {
  tx.delete(bench).where(eq(bench.taskIssueId, row.taskIssueId)).run()
  return workbenchLedger.removeRunspace(tx, row.runspaceId, { spare })
}
