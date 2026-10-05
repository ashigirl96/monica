import { describe, expect, test } from 'bun:test'

import type { AgentSession } from './contract.ts'
import {
  type AgentEvent,
  type HookEvent,
  type HookSignal,
  notificationFor,
  supersede,
  takesOverTerminal,
  transition,
} from './transition.ts'

const BEFORE = new Date(1_000)
const NOW = new Date(2_000)

const blank = {
  waitReason: null,
  waitTool: null,
  errorType: null,
  endReason: null,
  sessionEndReason: null,
  endedAt: null,
  unobservedSince: null,
} satisfies Partial<AgentSession>

type StateFields = Partial<AgentSession>

const running: StateFields = { state: 'running' }
const idle: StateFields = { state: 'waiting', waitReason: 'idle' }
const question: StateFields = { state: 'waiting', waitReason: 'question' }

const prior = {
  running,
  unobserved: { state: 'unobserved', unobservedSince: BEFORE },
  idle,
  question,
  permission: { state: 'waiting', waitReason: 'permission', waitTool: 'Edit' },
  error: { state: 'waiting', waitReason: 'error', errorType: 'rate_limit' },
  ended: {
    state: 'ended',
    endReason: 'session_end',
    sessionEndReason: 'prompt_input_exit',
    endedAt: BEFORE,
  },
} satisfies Record<string, StateFields>

function rowIn(state: keyof typeof prior, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 's-1',
    terminalSessionId: 'ts-a',
    ...blank,
    ...prior[state],
    cwd: '/work',
    transcriptPath: '/transcripts/s-1.jsonl',
    permissionMode: 'default',
    lastEventName: 'Earlier',
    lastEventAt: BEFORE,
    stateChangedAt: BEFORE,
    firstSeenAt: BEFORE,
    ...overrides,
  } as AgentSession
}

function hook(
  hookEventName: string,
  signal: HookSignal,
  overrides: Partial<HookEvent> = {},
): HookEvent {
  return {
    sessionId: 's-1',
    terminalSessionId: 'ts-a',
    hookEventName,
    cwd: '/work',
    transcriptPath: '/transcripts/s-1.jsonl',
    permissionMode: 'default',
    ...signal,
    ...overrides,
  } as HookEvent
}

// to: 新しい状態か理由に入り、state_changed_at が今になる。stay: state_changed_at は動かず、fields だけを上書きする。
type Cell = { moved: boolean; fields: StateFields } | null
const to = (fields: StateFields): Cell => ({ moved: true, fields })
const stay = (fields: StateFields = {}): Cell => ({ moved: false, fields })
const ignored: Cell = null

const inB: StateFields = { terminalSessionId: 'ts-b' }
const idleInB: StateFields = { ...idle, ...inB }
const runningInB: StateFields = { ...running, ...inB }
const permissionForBash: StateFields = {
  state: 'waiting',
  waitReason: 'permission',
  waitTool: 'Bash',
}
const serverError: StateFields = {
  state: 'waiting',
  waitReason: 'error',
  errorType: 'server_error',
}
const endedBySessionEnd: StateFields = {
  state: 'ended',
  endReason: 'session_end',
  sessionEndReason: 'other',
  endedAt: NOW,
}
const endedWithTerminal: StateFields = {
  state: 'ended',
  endReason: 'terminal_exited',
  endedAt: NOW,
}
const unobserved: StateFields = { state: 'unobserved', unobservedSince: NOW }

const columns = [...(Object.keys(prior) as (keyof typeof prior)[]), 'unknown'] as const

// 列は今の行の状態。unknown は session_id が Workbench Ledger に無い（行を動作中で作ってから当てる）。
// prettier-ignore
const table: [string, AgentEvent, Cell[]][] = [
  //                                                                                 running               unobserved            idle                  question              permission            error                 ended                 unknown
  ["SessionStart(resume) from another Terminal Session", hook("SessionStart", { type: "sessionStarted", compacted: false }, { terminalSessionId: "ts-b" }),
                                                                                    [to(idleInB),          to(idleInB),          stay(idleInB),        to(idleInB),          to(idleInB),          to(idleInB),          to(idleInB),          to(idleInB)]],
  ["SessionStart(compact)", hook("SessionStart", { type: "sessionStarted", compacted: true }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               stay(),               stay(),               ignored,              stay()]],
  ["UserPromptSubmit", hook("UserPromptSubmit", { type: "promptSubmitted" }),
                                                                                    [stay(),               to(running),          to(running),          to(running),          to(running),          to(running),          to(running),          stay()]],
  ["UserPromptSubmit from another Terminal Session whose SessionStart was missed", hook("UserPromptSubmit", { type: "promptSubmitted" }, { terminalSessionId: "ts-b" }),
                                                                                    [stay(inB),            to(runningInB),       to(runningInB),       to(runningInB),       to(runningInB),       to(runningInB),       to(runningInB),       stay()]],
  ["PreToolUse(AskUserQuestion) or PermissionRequest(AskUserQuestion)", hook("PreToolUse", { type: "questionAsked" }),
                                                                                    [to(question),         to(question),         to(question),         stay(),               to(question),         to(question),         to(question),         to(question)]],
  ["PermissionRequest(ExitPlanMode)", hook("PermissionRequest", { type: "planSubmitted" }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               stay(),               stay(),               ignored,              stay()]],
  ["PermissionRequest(Bash)", hook("PermissionRequest", { type: "permissionRequested", tool: "Bash" }),
                                                                                    [to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash)]],
  ["PostToolUse(AskUserQuestion)", hook("PostToolUse", { type: "questionAnswered" }),
                                                                                    [stay(),               to(running),          stay(),               to(running),          to(running),          stay(),               ignored,              stay()]],
  ["PostToolUse(Bash) or PostToolUseFailure(Bash)", hook("PostToolUse", { type: "toolFinished" }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               to(running),          stay(),               ignored,              stay()]],
  ["Stop without agent work", hook("Stop", { type: "turnStopped", agentWorkRunning: false }),
                                                                                    [to(idle),             to(idle),             stay(),               stay(),               to(idle),             to(idle),             ignored,              to(idle)]],
  ["Stop with agent work running", hook("Stop", { type: "turnStopped", agentWorkRunning: true }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               stay(),               stay(),               ignored,              stay()]],
  ["StopFailure(server_error)", hook("StopFailure", { type: "turnFailed", error: "server_error" }),
                                                                                    [to(serverError),      to(serverError),      to(serverError),      to(serverError),      to(serverError),      stay(serverError),    ignored,              to(serverError)]],
  ["SessionEnd(other)", hook("SessionEnd", { type: "sessionEnded", reason: "other" }),
                                                                                    [to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), ignored, to(endedBySessionEnd)]],
  ["the Terminal Session ended", { type: "terminalEnded" },
                                                                                    [to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), ignored, ignored]],
  ["the Backend restarted while the Terminal Session lived", { type: "backendRestarted" },
                                                                                    [to(unobserved),       ignored,              ignored,              ignored,              ignored,              ignored,              ignored,              ignored]],
]

function firstSeen(event: HookEvent): AgentSession {
  return {
    sessionId: event.sessionId,
    terminalSessionId: event.terminalSessionId,
    ...blank,
    state: 'running',
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    permissionMode: event.permissionMode,
    lastEventName: event.hookEventName,
    lastEventAt: NOW,
    stateChangedAt: NOW,
    firstSeenAt: NOW,
  }
}

function expectedRow(prev: AgentSession | null, event: AgentEvent, cell: Cell) {
  if (!cell) return null
  const observed = 'sessionId' in event ? event : null
  return {
    ...(prev ?? firstSeen(observed!)),
    ...(observed && { lastEventName: observed.hookEventName, lastEventAt: NOW }),
    ...(cell.moved && { ...blank, stateChangedAt: NOW }),
    ...cell.fields,
  }
}

describe.each(table)('%s', (_name, event, cells) => {
  test.each(columns.map((column, i) => [column, cells[i]!] as const))('from %s', (column, cell) => {
    const prev = column === 'unknown' ? null : rowIn(column)

    expect(transition(prev, event, NOW)).toEqual(expectedRow(prev, event, cell))
  })
})

describe('a session that takes over its Terminal Session', () => {
  const prompt = hook('UserPromptSubmit', { type: 'promptSubmitted' })

  test.each([
    [
      'any SessionStart',
      rowIn('running'),
      hook('SessionStart', { type: 'sessionStarted', compacted: true }),
      true,
    ],
    ['the first hook of a session the Workbench Ledger does not know', null, prompt, true],
    ['a hook reviving a session that had ended there', rowIn('ended'), prompt, true],
    [
      'a hook of a session that comes from another Terminal Session',
      rowIn('idle', { terminalSessionId: 'ts-b' }),
      prompt,
      true,
    ],
    ['a hook of a session already live there', rowIn('idle'), prompt, false],
    [
      'a late Stop to a session that had ended',
      rowIn('ended'),
      hook('Stop', { type: 'turnStopped', agentWorkRunning: false }),
      false,
    ],
    [
      'a SessionEnd of a session that comes from another Terminal Session',
      rowIn('idle', { terminalSessionId: 'ts-b' }),
      hook('SessionEnd', { type: 'sessionEnded', reason: 'other' }),
      false,
    ],
  ] as const)('is %s: %p', (_name, before, event, expected) => {
    expect(takesOverTerminal(before, transition(before, event, NOW), event)).toBe(expected)
  })

  test.each(['running', 'unobserved', 'idle', 'question', 'permission', 'error'] as const)(
    'ends the other live Agent Session there as superseded from %s',
    (state) => {
      const prev = rowIn(state, { sessionId: 's-2' })

      expect(supersede(prev, NOW)).toEqual({
        ...prev,
        ...blank,
        state: 'ended',
        endReason: 'superseded',
        endedAt: NOW,
        stateChangedAt: NOW,
      })
    },
  )
})

test('a hook refreshes the cwd, and keeps the last known permission mode when it carries none', () => {
  const moved = hook(
    'UserPromptSubmit',
    { type: 'promptSubmitted' },
    { cwd: '/elsewhere', permissionMode: 'plan' },
  )
  const modeless = hook(
    'SessionEnd',
    { type: 'sessionEnded', reason: 'other' },
    { permissionMode: null },
  )

  expect(transition(rowIn('idle'), moved, NOW)).toMatchObject({
    cwd: '/elsewhere',
    permissionMode: 'plan',
  })
  expect(
    transition(rowIn('running', { permissionMode: 'plan' }), modeless, NOW)?.permissionMode,
  ).toBe('plan')
})

// 列は transition の表と同じ今の行の状態。値は通知の本文で、null は出さない。
// prettier-ignore
const notifications: [string, HookEvent, (string | null)[]][] = [
  //                                                                                 running               unobserved            idle                  question              permission            error                 ended                 unknown
  ["SessionStart(startup or resume)", hook("SessionStart", { type: "sessionStarted", compacted: false }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["SessionStart(compact)", hook("SessionStart", { type: "sessionStarted", compacted: true }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["UserPromptSubmit", hook("UserPromptSubmit", { type: "promptSubmitted" }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["PreToolUse(AskUserQuestion) or PermissionRequest(AskUserQuestion)", hook("PreToolUse", { type: "questionAsked" }),
                                                                                    ["質問",               "質問",               "質問",               null,                 "質問",               "質問",               "質問",               "質問"]],
  ["PermissionRequest(ExitPlanMode)", hook("PermissionRequest", { type: "planSubmitted" }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["PermissionRequest(Bash)", hook("PermissionRequest", { type: "permissionRequested", tool: "Bash" }),
                                                                                    ["許可: Bash",         "許可: Bash",         "許可: Bash",         "許可: Bash",         "許可: Bash",         "許可: Bash",         "許可: Bash",         "許可: Bash"]],
  ["PostToolUse(AskUserQuestion)", hook("PostToolUse", { type: "questionAnswered" }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["PostToolUse(Bash) or PostToolUseFailure(Bash)", hook("PostToolUse", { type: "toolFinished" }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["Stop without agent work", hook("Stop", { type: "turnStopped", agentWorkRunning: false }),
                                                                                    ["手空き",             "手空き",             null,                 null,                 null,                 null,                 null,                 "手空き"]],
  ["Stop with agent work running", hook("Stop", { type: "turnStopped", agentWorkRunning: true }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
  ["StopFailure(server_error)", hook("StopFailure", { type: "turnFailed", error: "server_error" }),
                                                                                    ["エラー: server_error", "エラー: server_error", "エラー: server_error", "エラー: server_error", "エラー: server_error", null,          null,                 "エラー: server_error"]],
  ["StopFailure without an error type", hook("StopFailure", { type: "turnFailed", error: null }),
                                                                                    ["エラー",             "エラー",             "エラー",             "エラー",             "エラー",             null,                 null,                 "エラー"]],
  ["SessionEnd(other)", hook("SessionEnd", { type: "sessionEnded", reason: "other" }),
                                                                                    [null,                 null,                 null,                 null,                 null,                 null,                 null,                 null]],
]

describe.each(notifications)('notifying on %s', (_name, event, bodies) => {
  test.each(columns.map((column, i) => [column, bodies[i]!] as const))(
    'from %s',
    (column, body) => {
      const prev = column === 'unknown' ? null : rowIn(column)
      const next = transition(prev, event, NOW)

      expect(next && notificationFor(prev, event, next)).toBe(body)
    },
  )
})
