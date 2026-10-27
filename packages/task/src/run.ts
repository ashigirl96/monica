import { existsSync } from 'node:fs'

import { agentSession, tab, terminalSession } from '@monica/workbench/schema'
import { type Db, LIVE, terminating, type Tx } from '@monica/workbench/server'
import { and, desc, eq, gte, inArray, isNull, ne, not, type SQL, sql } from 'drizzle-orm'

import type { LiveRun } from './contract.ts'
import type { RunAgentSession } from './display-state.ts'
import { formatRef } from './ref.ts'
import { bench, issue, run, task } from './schema.ts'

type Reader = Pick<Db, 'select'>

export const liveAgentSession = ne(agentSession.state, 'ended')

export const latestRunFirst = [desc(agentSession.lastEventAt), desc(run.id)]

// resume できる Run。Claude Code は古い Agent Session Transcript を消すので、path を持たない Agent Session だけを無条件に resume できるとみなす。
export function isResumable({ transcriptPath }: { transcriptPath: string | null }): boolean {
  return transcriptPath === null || existsSync(transcriptPath)
}

export type RunOrigin = (typeof run.$inferInsert)['origin']

// Run になっている Agent Session は当て直さないので、Tab がどこへ移っても終わるまで元の Task の Run のまま。
export function applyRunInvariant(tx: Tx, origin: RunOrigin, agentSessionId?: string): string[] {
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
  const startedAt = new Date()
  tx.insert(run)
    .values(
      orphans.map((orphan) => ({
        taskIssueId: orphan.issue.id,
        agentSessionId: orphan.agentSessionId,
        origin,
        startedAt,
      })),
    )
    .run()
  return [...new Set(orphans.map((orphan) => formatRef(orphan.issue)))]
}

export function taskOfRun(reader: Reader, agentSessionMatches: SQL | undefined) {
  return reader
    .select({ task, issue, bench, agentSessionId: agentSession.sessionId })
    .from(agentSession)
    .innerJoin(run, eq(run.agentSessionId, agentSession.sessionId))
    .innerJoin(task, eq(task.issueId, run.taskIssueId))
    .innerJoin(issue, eq(issue.id, task.issueId))
    .leftJoin(bench, eq(bench.taskIssueId, task.issueId))
    .where(agentSessionMatches)
    .get()
}

// live な Run。Terminating な Terminal Session の Run も Exit の記録まで live と読む。
export function liveRunsByTask(reader: Reader, taskIssueIds: number[]) {
  const rows = reader
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

export const liveRunsOf = (reader: Reader, taskIssueId: number) =>
  liveRunsByTask(reader, [taskIssueId])(taskIssueId)

// Active Run。呼び手の Run は close の後も呼び手の Tab に残り、Terminating な Terminal Session の Run は終わったものと読むので除く（ADR-0023）。
export function activeRunsBesides(reader: Reader, taskIssueId: number, caller: string | undefined) {
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

// resume する Run。Bench より前の Run は reopen の前の挑戦で、Agent Session Transcript の無い Agent Session（claude は最初の prompt まで書かない）は --resume が会話を見つけられないので、どちらも候補にしない。
export function runToResume(reader: Reader, taskIssueId: number, since: { createdAt: Date }) {
  return reader
    .select({
      agentSessionId: agentSession.sessionId,
      cwd: agentSession.cwd,
      transcriptPath: agentSession.transcriptPath,
    })
    .from(run)
    .innerJoin(agentSession, eq(agentSession.sessionId, run.agentSessionId))
    .where(and(eq(run.taskIssueId, taskIssueId), gte(run.startedAt, since.createdAt)))
    .orderBy(...latestRunFirst)
    .all()
    .find(isResumable)
}

// claude は shell に打鍵して起こすので、SessionStart の前に claude だけが抜けると Terminal Session は生き続け、終わりが届かない。
export const LAUNCH_TIMEOUT_MS = 60_000

export type RunLaunches = ReturnType<typeof createRunLaunches>

// Run の起動は Tab を開いてから Run になるまでの間で終わるので、DB ではなく Backend の memory に置く。
export function createRunLaunches() {
  const launches = new Map<number, { terminalSessionId: string; since: number }>()

  // 外す合図を待たずに読むたびに確かめるので、Tab を閉じた直後や Exit を記録した直後の close は合図より先に来ても断られない。
  function hasRunLaunch(reader: Reader, taskIssueId: number): boolean {
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
    // Tab は Runspace 間で移るが、Terminal Session は変わらない。
    begin(taskIssueId: number, terminalSessionId: string) {
      launches.set(taskIssueId, { terminalSessionId, since: Date.now() })
    },
    end(taskIssueId: number) {
      launches.delete(taskIssueId)
    },
    hasRunLaunch,
  }
}

// Terminating な Terminal Session は Exit の記録を待たずに外す（ADR-0023）。
function stillLaunching(reader: Reader, taskIssueId: number, terminalSessionId: string): boolean {
  const live = reader
    .select({ id: terminalSession.id })
    .from(terminalSession)
    .where(
      and(
        eq(terminalSession.id, terminalSessionId),
        inArray(terminalSession.status, LIVE),
        not(terminating(reader, terminalSessionId)),
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
