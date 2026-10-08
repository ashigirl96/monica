import type { Db } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'
import { eq, type SQL } from 'drizzle-orm'

import { formatRef } from './ref.ts'
import { bench, issue, task } from './schema.ts'

export function findTrackedTask(db: Pick<Db, 'select'>, where: SQL | undefined, asked: string) {
  const found = db
    .select({ task, issue, bench })
    .from(task)
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(where)
    .get()
  if (!found) throw new ORPCError('NOT_FOUND', { message: `${asked} is not tracked` })
  return found
}

export function findOpenTask(db: Pick<Db, 'select'>, where: SQL | undefined, asked: string) {
  const found = findTrackedTask(db, where, asked)
  const ref = formatRef(found.issue)
  if (found.task.closedAt) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${ref} is closed, so run \`monica task reopen ${ref}\``,
    })
  }
  return found
}
