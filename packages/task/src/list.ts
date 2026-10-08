import type { Db } from '@monica/workbench/server'
import { asc, eq, isNotNull, isNull } from 'drizzle-orm'

import type { ListItem } from './contract.ts'
import { openBlockersOf } from './copy.ts'
import { displayState } from './display-state.ts'
import { formatRef } from './ref.ts'
import { runAgentSessionsByTask } from './run.ts'
import { bench, issue, task } from './schema.ts'

export function listTasks(db: Db, { closed }: { closed: boolean }): ListItem[] {
  const rows = db
    .select({ task, issue, bench })
    .from(task)
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(closed ? isNotNull(task.closedAt) : isNull(task.closedAt))
    .orderBy(asc(task.trackedAt), asc(task.issueId))
    .all()
  const openBlockers = openBlockersOf(
    db,
    rows.map((row) => row.issue.id),
  )
  const runsOf = runAgentSessionsByTask(
    db,
    rows.map((row) => row.issue.id),
  )
  return rows.map((row) => ({
    ref: formatRef(row.issue),
    title: row.issue.title,
    issueState: row.issue.state,
    blockers: openBlockers.filter((b) => b.issueId === row.issue.id).map(formatRef),
    cwd: row.bench?.cwd ?? null,
    displayState: displayState(row.task, row.issue, row.bench, runsOf(row.issue.id)),
  }))
}
