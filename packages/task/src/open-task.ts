import type { Db } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'
import { eq, type SQL } from 'drizzle-orm'

import { formatRef } from './ref.ts'
import { bench, issue, task } from './schema.ts'

export function taskIfTracked(db: Pick<Db, 'select'>, where: SQL | undefined) {
  return db
    .select({ task, issue, bench })
    .from(task)
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(where)
    .get()
}

type FoundTask = NonNullable<ReturnType<typeof taskIfTracked>>

export function findTrackedTask(db: Pick<Db, 'select'>, where: SQL | undefined, asked: string) {
  const found = taskIfTracked(db, where)
  if (!found) throw new ORPCError('NOT_FOUND', { message: `${asked} is not tracked` })
  return found
}

export function findOpenTask(db: Pick<Db, 'select'>, where: SQL | undefined, asked: string) {
  return refuseClosed(findTrackedTask(db, where, asked))
}

export function refuseClosed(found: FoundTask): FoundTask {
  const ref = formatRef(found.issue)
  if (found.task.closedAt) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${ref} is closed, so run \`monica task reopen ${ref}\``,
    })
  }
  return found
}
