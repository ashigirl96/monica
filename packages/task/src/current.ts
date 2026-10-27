import { agentSession, tab } from '@monica/workbench/schema'
import type { Db } from '@monica/workbench/server'
import { ORPCError } from '@orpc/server'
import { and, eq } from 'drizzle-orm'

import type { CurrentOutput } from './contract.ts'
import { displayState } from './display-state.ts'
import { taskLabel } from './label.ts'
import { formatRef } from './ref.ts'
import { liveAgentSession, liveRunsOf, taskOfRun } from './run.ts'
import { bench, issue, task } from './schema.ts'

export function callerTerminalSession(terminalSessionId: string | undefined): string {
  if (!terminalSessionId) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'not in a Tab of the Workbench: MONICA_TERMINAL_SESSION_ID is not set',
    })
  }
  return terminalSessionId
}

export function currentTask(db: Db, caller: string | undefined): CurrentOutput {
  const terminalSessionId = callerTerminalSession(caller)
  const byRun = taskOfRun(
    db,
    and(eq(agentSession.terminalSessionId, terminalSessionId), liveAgentSession),
  )
  const found = byRun ?? taskOfBench(db, terminalSessionId)
  if (!found) {
    throw new ORPCError('NOT_FOUND', {
      message: `Terminal Session ${terminalSessionId} runs no Run of a Task, and its Tab is not in a Bench`,
    })
  }
  return {
    ref: formatRef(found.issue),
    title: found.issue.title,
    displayState: displayState(
      found.task,
      found.issue,
      found.bench,
      liveRunsOf(db, found.task.issueId),
    ),
    agentSessionId: byRun?.agentSessionId ?? null,
    source: byRun ? 'run' : 'bench',
  }
}

// Bench の Tab で始まったばかりの Agent Session の Run は、購読の microtask が作るまでまだ無い。
export function nameAgentSession(db: Db, agentSessionId: string): string | null {
  const found =
    taskOfRun(db, eq(agentSession.sessionId, agentSessionId)) ??
    taskOfBenchHosting(db, agentSessionId)
  return found ? taskLabel(formatRef(found.issue), found.issue.title) : null
}

function taskOfBench(db: Db, terminalSessionId: string) {
  return db
    .select({ task, issue, bench })
    .from(tab)
    .innerJoin(bench, eq(bench.runspaceId, tab.runspaceId))
    .innerJoin(task, eq(task.issueId, bench.taskIssueId))
    .innerJoin(issue, eq(issue.id, task.issueId))
    .where(eq(tab.terminalSessionId, terminalSessionId))
    .get()
}

function taskOfBenchHosting(db: Db, agentSessionId: string) {
  const host = db
    .select({ terminalSessionId: agentSession.terminalSessionId })
    .from(agentSession)
    .where(eq(agentSession.sessionId, agentSessionId))
    .get()
  return host ? taskOfBench(db, host.terminalSessionId) : undefined
}
