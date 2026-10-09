import { agentSession, terminalSession } from '@monica/workbench/schema'
import type { Db, Tx } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'
import { and, eq, inArray } from 'drizzle-orm'

import { type FoundTask, findTrackedTask, refuseClosed, refuseOpen } from './open-task.ts'
import { formatRef } from './ref.ts'
import { issue, run } from './schema.ts'

export type Prepared = { warnings: string[] } | { error: string }

export type Reservations = ReturnType<typeof createReservations>

// claude は shell に打鍵して起こすので、SessionStart の前に claude だけが抜けると Terminal Session は生き続け、終わりが届かない。
export const LAUNCH_TIMEOUT_MS = 60_000

// 予約の寿命は request 1 本か Run の起動の間で終わるので、DB ではなく Backend の memory に置く。
export function createReservations(db: Db) {
  const closing = new Set<number>()
  const preparations = new Map<number, Promise<Prepared>>()
  const launches = new Map<number, { terminalSessionId: string; since: number }>()

  function writeTask<T>(
    taskIssueId: number,
    asked: string,
    refuseState: (found: FoundTask) => FoundTask,
    write: (tx: Tx, found: FoundTask) => T,
  ): T {
    return db.transaction((tx) => {
      const found = findTrackedTask(tx, eq(issue.id, taskIssueId), asked)
      // close が commit した後も、返るまでは閉じた状態を誰にも変えさせない。
      if (closing.has(taskIssueId)) throw beingClosed(formatRef(found.issue))
      return write(tx, refuseState(found))
    })
  }

  // 外す合図を待たずに読むたびに確かめるので、Exit を記録した直後の close は合図より先に来ても断られない。
  function launchingRun(reader: Pick<Db, 'select'>, taskIssueId: number): boolean {
    const launch = launches.get(taskIssueId)
    if (!launch) return false
    if (
      Date.now() - launch.since < LAUNCH_TIMEOUT_MS &&
      stillLaunching(reader, taskIssueId, launch.terminalSessionId)
    ) {
      return true
    }
    launches.delete(taskIssueId)
    return false
  }

  return {
    writeOpenTask<T>(taskIssueId: number, asked: string, write: (tx: Tx, found: FoundTask) => T) {
      return writeTask(taskIssueId, asked, refuseClosed, write)
    },
    writeClosedTask<T>(taskIssueId: number, asked: string, write: (tx: Tx, found: FoundTask) => T) {
      return writeTask(taskIssueId, asked, refuseOpen, write)
    },
    // transaction は同期なので、commit から予約を書くまでに別の request は割り込まない。
    openRunTab<T extends { terminalSessionId: string }>(
      taskIssueId: number,
      asked: string,
      open: (tx: Tx, found: FoundTask) => T,
    ): T {
      const opened = writeTask(taskIssueId, asked, refuseClosed, open)
      // Tab は Runspace 間で移るが、Terminal Session は変わらない。
      launches.set(taskIssueId, { terminalSessionId: opened.terminalSessionId, since: Date.now() })
      return opened
    },
    launchingRun,
    // 準備は worktree と Bench の行を書き続けるので、走っている間は --force でも close させない。
    async whileClosing<T>(
      taskIssueId: number,
      ref: string,
      force: boolean,
      close: () => Promise<T>,
    ): Promise<T> {
      if (closing.has(taskIssueId)) throw beingClosed(ref)
      if (preparations.has(taskIssueId)) {
        throw new ORPCError('CONFLICT', {
          message: `the Bench of ${ref} is being prepared; close it once the setup ends, or times out after 600s`,
        })
      }
      if (!force && launchingRun(db, taskIssueId)) {
        throw new ORPCError('CONFLICT', {
          message: `${ref} has a Run being started; close it once its claude starts, or pass --force to close anyway`,
        })
      }
      closing.add(taskIssueId)
      try {
        const closed = await close()
        launches.delete(taskIssueId)
        return closed
      } finally {
        closing.delete(taskIssueId)
      }
    },
    preparation(taskIssueId: number): Promise<Prepared> | undefined {
      return preparations.get(taskIssueId)
    },
    prepare(taskIssueId: number, start: () => Promise<Prepared>): Promise<Prepared> {
      const started = start().finally(() => preparations.delete(taskIssueId))
      preparations.set(taskIssueId, started)
      return started
    },
  }
}

function stillLaunching(
  reader: Pick<Db, 'select'>,
  taskIssueId: number,
  terminalSessionId: string,
): boolean {
  const live = reader
    .select({ id: terminalSession.id })
    .from(terminalSession)
    .where(
      and(
        eq(terminalSession.id, terminalSessionId),
        inArray(terminalSession.status, ['starting', 'running']),
      ),
    )
    .get()
  if (!live) return false
  const started = reader
    .select({ id: run.id })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(
      and(eq(run.taskIssueId, taskIssueId), eq(agentSession.terminalSessionId, terminalSessionId)),
    )
    .get()
  return started === undefined
}

function beingClosed(ref: string) {
  return new ORPCError('CONFLICT', { message: `${ref} is being closed` })
}
