import { agentSession } from '@monica/workbench/schema'
import type { Db } from '@monica/workbench/server'
import { eq } from 'drizzle-orm'

import type { ShowOutput } from './contract.ts'
import { isIssue } from './copy.ts'
import { findTrackedTask } from './open-task.ts'
import { formatRef, parseRef } from './ref.ts'
import { isResumable, latestRunFirst } from './run.ts'
import { run } from './schema.ts'

export function showTask(db: Db, asked: string): ShowOutput {
  const ref = parseRef(asked)
  const found = findTrackedTask(db, isIssue(ref), formatRef(ref))
  const rows = db
    .select({
      agentSessionId: agentSession.sessionId,
      state: agentSession.state,
      origin: run.origin,
      startedAt: run.startedAt,
      lastEventAt: agentSession.lastEventAt,
      endedAt: agentSession.endedAt,
      cwd: agentSession.cwd,
      transcriptPath: agentSession.transcriptPath,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(eq(run.taskIssueId, found.issue.id))
    .orderBy(...latestRunFirst)
    .all()
  return {
    ref: formatRef(found.issue),
    title: found.issue.title,
    closedAt: found.task.closedAt,
    runs: rows.map((row) => ({ ...row, resumable: isResumable(row) })),
  }
}
