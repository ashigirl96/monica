import { expect, test } from 'bun:test'

import type { AgentSession } from '../contract.ts'
import { agentDotOf } from './agent-dot.ts'

const at = new Date(0)

function agentSessionIn(fields: Partial<AgentSession>): AgentSession {
  return {
    sessionId: 's-1',
    terminalSessionId: 'ts-a',
    state: 'running',
    waitReason: null,
    waitTool: null,
    errorType: null,
    endReason: null,
    sessionEndReason: null,
    cwd: '/work',
    transcriptPath: null,
    permissionMode: null,
    lastEventName: 'UserPromptSubmit',
    lastEventAt: at,
    stateChangedAt: at,
    firstSeenAt: at,
    endedAt: null,
    unobservedSince: null,
    notifiedAt: null,
    seenAt: null,
    ...fields,
  }
}

test.each([
  ['running', { state: 'running' }, 'running'],
  ['waiting for the next prompt', { state: 'waiting', waitReason: 'idle' }, 'idle'],
  ['asking a question', { state: 'waiting', waitReason: 'question' }, 'question'],
  [
    'asking for permission',
    { state: 'waiting', waitReason: 'permission', waitTool: 'Bash' },
    'permission',
  ],
  ['stopped by an API error', { state: 'waiting', waitReason: 'error' }, 'error'],
  ['unobserved', { state: 'unobserved', unobservedSince: at }, 'unobserved'],
  ['ended', { state: 'ended', endReason: 'session_end', endedAt: at }, null],
] as const)('a Tab whose Agent Session is %s shows %p', (_name, fields, dot) => {
  expect(agentDotOf(agentSessionIn(fields))).toBe(dot)
})

test('a Tab without an Agent Session shows no dot', () => {
  expect(agentDotOf(undefined)).toBeNull()
})
