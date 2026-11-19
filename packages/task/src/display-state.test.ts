import { expect, test } from 'bun:test'

import type { DisplayState } from './contract.ts'
import { type RunAgentSession, displayState } from './display-state.ts'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 3, minute))

function session(
  sessionId: string,
  state: RunAgentSession['state'],
  minute: number,
  wait: Partial<Pick<RunAgentSession, 'waitReason' | 'waitTool' | 'errorType'>> = {},
): RunAgentSession {
  return {
    sessionId,
    state,
    waitReason: null,
    waitTool: null,
    errorType: null,
    stateChangedAt: at(minute),
    ...wait,
  }
}

const idle = (id: string, minute: number) => session(id, 'waiting', minute, { waitReason: 'idle' })
const question = (id: string, minute: number) =>
  session(id, 'waiting', minute, { waitReason: 'question' })
const permission = (id: string, minute: number, tool: string) =>
  session(id, 'waiting', minute, { waitReason: 'permission', waitTool: tool })
const error = (id: string, minute: number, errorType: string) =>
  session(id, 'waiting', minute, { waitReason: 'error', errorType })
const running = (id: string, minute: number) => session(id, 'running', minute)
const unobserved = (id: string, minute: number) => session(id, 'unobserved', minute)
const ended = (id: string, minute: number) => session(id, 'ended', minute)

const open = { closedAt: null }
const withBench = true

test.each<
  [string, { closedAt: Date | null }, 'open' | 'closed', boolean, RunAgentSession[], DisplayState]
>([
  [
    'a closed Task, even with a live Run',
    { closedAt: at(0) },
    'open',
    withBench,
    [idle('a', 1)],
    {
      state: 'closed',
    },
  ],
  [
    'a live Run before a closed Issue',
    open,
    'closed',
    withBench,
    [idle('a', 1)],
    {
      state: 'waiting',
      reason: 'idle',
      since: at(1),
      liveRuns: [{ agentSessionId: 'a', state: 'waiting', reason: 'idle', since: at(1) }],
    },
  ],
  [
    'a closed Issue with no live Run',
    open,
    'closed',
    withBench,
    [ended('a', 1)],
    {
      state: 'issue_closed',
    },
  ],
  ['no Bench', open, 'open', false, [], { state: 'not_started' }],
  ['a Bench whose Runs all ended', open, 'open', withBench, [ended('a', 1)], { state: 'ended' }],
  [
    'a running Run',
    open,
    'open',
    withBench,
    [running('a', 2)],
    {
      state: 'running',
      since: at(2),
      liveRuns: [{ agentSessionId: 'a', state: 'running', since: at(2) }],
    },
  ],
  [
    'an unobserved Run',
    open,
    'open',
    withBench,
    [unobserved('a', 2)],
    {
      state: 'unobserved',
      since: at(2),
      liveRuns: [{ agentSessionId: 'a', state: 'unobserved', since: at(2) }],
    },
  ],
  [
    'a Run waiting for permission names the tool',
    open,
    'open',
    withBench,
    [permission('a', 2, 'Bash')],
    {
      state: 'waiting',
      reason: 'permission',
      tool: 'Bash',
      since: at(2),
      liveRuns: [{ agentSessionId: 'a', state: 'waiting', reason: 'permission', since: at(2) }],
    },
  ],
  [
    'a Run waiting on an error names its type',
    open,
    'open',
    withBench,
    [error('a', 2, 'rate_limit')],
    {
      state: 'waiting',
      reason: 'error',
      errorType: 'rate_limit',
      since: at(2),
      liveRuns: [{ agentSessionId: 'a', state: 'waiting', reason: 'error', since: at(2) }],
    },
  ],
  [
    'waiting before unobserved before running',
    open,
    'open',
    withBench,
    [running('run', 1), unobserved('unobserved', 2), idle('idle', 3), ended('ended', 0)],
    {
      state: 'waiting',
      reason: 'idle',
      since: at(3),
      liveRuns: [
        { agentSessionId: 'idle', state: 'waiting', reason: 'idle', since: at(3) },
        { agentSessionId: 'unobserved', state: 'unobserved', since: at(2) },
        { agentSessionId: 'run', state: 'running', since: at(1) },
      ],
    },
  ],
  [
    'unobserved before running',
    open,
    'open',
    withBench,
    [running('run', 1), unobserved('unobserved', 2)],
    {
      state: 'unobserved',
      since: at(2),
      liveRuns: [
        { agentSessionId: 'unobserved', state: 'unobserved', since: at(2) },
        { agentSessionId: 'run', state: 'running', since: at(1) },
      ],
    },
  ],
  [
    'a question or permission before an error before idle',
    open,
    'open',
    withBench,
    [idle('idle', 1), error('error', 2, 'server_error'), permission('permission', 3, 'Edit')],
    {
      state: 'waiting',
      reason: 'permission',
      tool: 'Edit',
      since: at(3),
      liveRuns: [
        { agentSessionId: 'permission', state: 'waiting', reason: 'permission', since: at(3) },
        { agentSessionId: 'error', state: 'waiting', reason: 'error', since: at(2) },
        { agentSessionId: 'idle', state: 'waiting', reason: 'idle', since: at(1) },
      ],
    },
  ],
  [
    'a question and a permission rank the same, the longer wait first',
    open,
    'open',
    withBench,
    [permission('permission', 5, 'Bash'), question('question', 4)],
    {
      state: 'waiting',
      reason: 'question',
      since: at(4),
      liveRuns: [
        { agentSessionId: 'question', state: 'waiting', reason: 'question', since: at(4) },
        { agentSessionId: 'permission', state: 'waiting', reason: 'permission', since: at(5) },
      ],
    },
  ],
  [
    'the same rank puts the longer wait first',
    open,
    'open',
    withBench,
    [idle('later', 6), idle('earlier', 5)],
    {
      state: 'waiting',
      reason: 'idle',
      since: at(5),
      liveRuns: [
        { agentSessionId: 'earlier', state: 'waiting', reason: 'idle', since: at(5) },
        { agentSessionId: 'later', state: 'waiting', reason: 'idle', since: at(6) },
      ],
    },
  ],
])('%s', (_, task, issueState, hasBench, runs, expected) => {
  expect(displayState(task, { state: issueState }, hasBench, runs)).toEqual(expected)
})
