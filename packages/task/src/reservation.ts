import type { Db, Tx } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'

import { type FoundTask, findTrackedTask, refuseClosed, refuseOpen } from './open-task.ts'
import { formatRef } from './ref.ts'
import { issue } from './schema.ts'

export type Prepared = { warnings: string[] } | { error: string }

export type Reservations = ReturnType<typeof createReservations>

// 予約の寿命は close の request 1 本の中で終わるので、DB ではなく Backend の memory に置く。
export function createReservations(db: Db) {
  const closing = new Set<number>()
  const preparations = new Map<number, Promise<Prepared>>()

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

  return {
    writeOpenTask<T>(taskIssueId: number, asked: string, write: (tx: Tx, found: FoundTask) => T) {
      return writeTask(taskIssueId, asked, refuseClosed, write)
    },
    writeClosedTask<T>(taskIssueId: number, asked: string, write: (tx: Tx, found: FoundTask) => T) {
      return writeTask(taskIssueId, asked, refuseOpen, write)
    },
    // 準備は worktree と Bench の行を書き続けるので、走っている間は --force でも close させない。
    async whileClosing<T>(taskIssueId: number, ref: string, close: () => Promise<T>): Promise<T> {
      if (closing.has(taskIssueId)) throw beingClosed(ref)
      if (preparations.has(taskIssueId)) {
        throw new ORPCError('CONFLICT', {
          message: `the Bench of ${ref} is being prepared; close it once the setup ends, or times out after 600s`,
        })
      }
      closing.add(taskIssueId)
      try {
        return await close()
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

function beingClosed(ref: string) {
  return new ORPCError('CONFLICT', { message: `${ref} is being closed` })
}
