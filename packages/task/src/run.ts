import { existsSync } from 'node:fs'

import { agentSession, tab } from '@monica/workbench/schema'
import { type Db, terminating, type Tx } from '@monica/workbench/server'
import { and, eq, inArray, isNull, ne, not, sql } from 'drizzle-orm'

import type { LiveRun } from './contract.ts'
import type { RunAgentSession } from './display-state.ts'
import { formatRef } from './ref.ts'
import { bench, issue, run } from './schema.ts'

export const liveAgentSession = ne(agentSession.state, 'ended')

// Claude Code は古い Agent Session Transcript を消すので、path を持たない Agent Session だけを無条件に resume できるとみなす。
export function isResumable({ transcriptPath }: { transcriptPath: string | null }): boolean {
  return transcriptPath === null || existsSync(transcriptPath)
}

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

// 見せる用の Run。Terminating な Terminal Session の Run も Exit の記録まで live と読む。
export function runAgentSessionsByTask(db: Pick<Db, 'select'>, taskIssueIds: number[]) {
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

// ActiveRun。呼び手の Run は close の後も呼び手の Tab に残り、Terminating な Terminal Session の Run は終わったものと読むので除く（ADR-0023）。
export function activeRunsBesides(
  reader: Pick<Db, 'select'>,
  taskIssueId: number,
  caller: string | undefined,
) {
  return reader
    .select({
      agentSessionId: agentSession.sessionId,
      // where の liveAgentSession が ended を除く。
      state: sql<LiveRun['state']>`${agentSession.state}`,
      terminalSessionId: agentSession.terminalSessionId,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(
      and(
        eq(run.taskIssueId, taskIssueId),
        liveAgentSession,
        not(terminating(reader, agentSession.terminalSessionId)),
        caller === undefined ? undefined : ne(agentSession.terminalSessionId, caller),
      ),
    )
    .orderBy(run.id)
    .all()
}
