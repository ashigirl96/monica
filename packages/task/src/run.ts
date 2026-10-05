import { agentSession, tab } from '@tania/workbench/schema'
import type { Db, Tx } from '@tania/workbench/server'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'

import type { RunAgentSession } from './display-state.ts'
import { formatRef } from './ref.ts'
import { bench, issue, run } from './schema.ts'

export const liveAgentSession = ne(agentSession.state, 'ended')

export type RunOrigin = (typeof run.$inferInsert)['origin']

export function insertRuns(
  tx: Tx,
  origin: RunOrigin,
  runs: { taskIssueId: number; agentSessionId: string }[],
) {
  const startedAt = new Date()
  tx.insert(run)
    .values(runs.map((r) => ({ ...r, origin, startedAt })))
    .run()
}

// Run になっている Agent Session は当て直さないので、Tab がどこへ移っても終わるまで元の Task の Run のまま。
export function applyRunInvariant(db: Db, origin: RunOrigin, agentSessionId?: string): string[] {
  return db.transaction((tx) => {
    const orphans = tx
      .select({ agentSessionId: agentSession.sessionId, issue })
      .from(agentSession)
      .innerJoin(tab, eq(tab.terminalSessionId, agentSession.terminalSessionId))
      .innerJoin(bench, eq(bench.runspaceId, tab.runspaceId))
      .innerJoin(issue, eq(issue.id, bench.taskIssueId))
      .leftJoin(run, eq(run.agentSessionId, agentSession.sessionId))
      .where(
        and(
          liveAgentSession,
          isNull(run.id),
          agentSessionId === undefined ? undefined : eq(agentSession.sessionId, agentSessionId),
        ),
      )
      .all()
    if (orphans.length === 0) return []
    insertRuns(
      tx,
      origin,
      orphans.map((orphan) => ({
        taskIssueId: orphan.issue.id,
        agentSessionId: orphan.agentSessionId,
      })),
    )
    return [...new Set(orphans.map((orphan) => formatRef(orphan.issue)))]
  })
}

export function refOfRunTask(db: Db, agentSessionId: string): string | null {
  const found = db
    .select({ repo: issue.repo, number: issue.number })
    .from(run)
    .innerJoin(issue, eq(issue.id, run.taskIssueId))
    .where(eq(run.agentSessionId, agentSessionId))
    .get()
  return found ? formatRef(found) : null
}

export function runAgentSessionsByTask(db: Db, taskIssueIds: number[]) {
  const rows = db
    .select({
      taskIssueId: run.taskIssueId,
      sessionId: agentSession.sessionId,
      state: agentSession.state,
      waitReason: agentSession.waitReason,
      waitTool: agentSession.waitTool,
      errorType: agentSession.errorType,
      stateChangedAt: agentSession.stateChangedAt,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(and(inArray(run.taskIssueId, taskIssueIds), liveAgentSession))
    .all()
  const byTask = new Map<number, RunAgentSession[]>()
  for (const { taskIssueId, ...row } of rows) {
    byTask.set(taskIssueId, [...(byTask.get(taskIssueId) ?? []), row])
  }
  return (taskIssueId: number) => byTask.get(taskIssueId) ?? []
}
