import type { agentSession } from '@monica/workbench/schema'

import type { DisplayState, LiveRun } from './contract.ts'
import type { bench as benchTable, issue, task } from './schema.ts'

export type RunAgentSession = Pick<
  typeof agentSession.$inferSelect,
  'sessionId' | 'state' | 'waitReason' | 'waitTool' | 'errorType' | 'stateChangedAt'
>

type LiveAgentSession = RunAgentSession & { state: LiveRun['state'] }

const ORDER = { question: 0, permission: 0, error: 1, idle: 2, unobserved: 3, running: 4 }

export function displayState(
  { closedAt }: Pick<typeof task.$inferSelect, 'closedAt'>,
  { state }: Pick<typeof issue.$inferSelect, 'state'>,
  bench: Pick<typeof benchTable.$inferSelect, 'setupState'> | null,
  runs: RunAgentSession[],
): DisplayState {
  if (closedAt) return { state: 'closed' }
  const live = runs
    .filter(isLive)
    .toSorted(
      (a, b) => orderOf(a) - orderOf(b) || a.stateChangedAt.getTime() - b.stateChangedAt.getTime(),
    )
  const first = live[0]
  if (first) return aggregate(first, live.map(asLiveRun))
  if (state === 'closed') return { state: 'issue_closed' }
  if (!bench) return { state: 'not_started' }
  if (bench.setupState === 'preparing') return { state: 'preparing' }
  if (bench.setupState === 'failed') return { state: 'setup_failed' }
  return { state: 'ended' }
}

function isLive(run: RunAgentSession): run is LiveAgentSession {
  return run.state !== 'ended'
}

function orderOf(run: LiveAgentSession): number {
  return ORDER[run.state === 'waiting' ? run.waitReason! : run.state]
}

function aggregate(first: LiveAgentSession, liveRuns: LiveRun[]): DisplayState {
  const since = first.stateChangedAt
  if (first.state !== 'waiting') return { state: first.state, since, liveRuns }
  const reason = first.waitReason!
  return {
    state: 'waiting',
    reason,
    ...(reason === 'permission' && first.waitTool !== null && { tool: first.waitTool }),
    ...(reason === 'error' && first.errorType !== null && { errorType: first.errorType }),
    since,
    liveRuns,
  }
}

function asLiveRun(run: LiveAgentSession): LiveRun {
  return {
    agentSessionId: run.sessionId,
    state: run.state,
    ...(run.waitReason !== null && { reason: run.waitReason }),
    since: run.stateChangedAt,
  }
}
