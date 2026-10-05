import type { AgentSession } from './contract.ts'

export type HookSignal =
  | { type: 'sessionStarted'; compacted: boolean }
  | { type: 'promptSubmitted' }
  | { type: 'questionAsked' }
  | { type: 'planSubmitted' }
  | { type: 'permissionRequested'; tool: string }
  | { type: 'questionAnswered' }
  | { type: 'toolFinished' }
  | { type: 'turnStopped'; agentWorkRunning: boolean }
  | { type: 'turnFailed'; error: string | null }
  | { type: 'sessionEnded'; reason: string | null }

export type HookEvent = {
  sessionId: string
  terminalSessionId: string
  hookEventName: string
  cwd: string
  transcriptPath: string | null
  permissionMode: string | null
} & HookSignal

export type AgentEvent = HookEvent | { type: 'terminalEnded' } | { type: 'backendRestarted' }

type Verdict = { fields: Partial<AgentSession>; newWait?: boolean } | 'unchanged' | 'ignored'

const CLEARED = {
  waitReason: null,
  waitTool: null,
  errorType: null,
  endReason: null,
  sessionEndReason: null,
  endedAt: null,
  unobservedSince: null,
} satisfies Partial<AgentSession>

export function transition(
  row: AgentSession | null,
  event: AgentEvent,
  now: Date,
): AgentSession | null {
  if (event.type === 'terminalEnded') {
    if (!row || row.state === 'ended') return null
    return enter(row, { state: 'ended', endReason: 'terminal_exited', endedAt: now }, now)
  }
  if (event.type === 'backendRestarted') {
    return row?.state === 'running'
      ? enter(row, { state: 'unobserved', unobservedSince: now }, now)
      : null
  }

  const current = row ?? firstSeen(event, now)
  const verdict = verdictFor(current, event, now)
  if (verdict === 'ignored') return null
  // resume の SessionStart を取りこぼしても、別の Tab へ移った agent を今の Tab に結び直す。
  const recorded: AgentSession = {
    ...current,
    terminalSessionId: event.terminalSessionId,
    cwd: event.cwd,
    lastEventName: event.hookEventName,
    lastEventAt: now,
    permissionMode: event.permissionMode ?? current.permissionMode,
  }
  if (verdict === 'unchanged') {
    return recorded.state === 'unobserved' ? enter(recorded, { state: 'running' }, now) : recorded
  }
  const moved =
    verdict.newWait ||
    verdict.fields.state !== recorded.state ||
    (verdict.fields.waitReason ?? null) !== recorded.waitReason
  return moved ? enter(recorded, verdict.fields, now) : { ...recorded, ...verdict.fields }
}

function verdictFor(current: AgentSession, event: HookEvent, now: Date): Verdict {
  // 遅れて届いた Stop や SessionEnd で終了の行を動かさないよう、動き直すのは agent が生きている証拠になる event だけにする。
  if (current.state === 'ended' && !provesAlive(event)) return 'ignored'
  const reason = current.state === 'waiting' ? current.waitReason : null
  switch (event.type) {
    case 'sessionStarted':
      if (event.compacted) return 'unchanged'
      return { fields: { state: 'waiting', waitReason: 'idle' } }
    case 'promptSubmitted':
      return { fields: { state: 'running' } }
    case 'questionAsked':
      return { fields: { state: 'waiting', waitReason: 'question' } }
    case 'planSubmitted':
      return 'unchanged'
    // 許可した tool が終わるまで許可待ちに見えたままなので、その間に来た次の許可も新しい待ちにする（ADR-0008）。
    case 'permissionRequested':
      return {
        fields: { state: 'waiting', waitReason: 'permission', waitTool: event.tool },
        newWait: true,
      }
    case 'questionAnswered':
      return reason === 'question' || reason === 'permission'
        ? { fields: { state: 'running' } }
        : 'unchanged'
    case 'toolFinished':
      return reason === 'permission' ? { fields: { state: 'running' } } : 'unchanged'
    case 'turnStopped':
      return event.agentWorkRunning || reason === 'question'
        ? 'unchanged'
        : { fields: { state: 'waiting', waitReason: 'idle' } }
    case 'turnFailed':
      return { fields: { state: 'waiting', waitReason: 'error', errorType: event.error } }
    case 'sessionEnded':
      return {
        fields: {
          state: 'ended',
          endReason: 'session_end',
          sessionEndReason: event.reason,
          endedAt: now,
        },
      }
  }
}

function provesAlive(event: HookEvent): boolean {
  switch (event.type) {
    case 'sessionStarted':
      return !event.compacted
    case 'promptSubmitted':
    case 'questionAsked':
    case 'permissionRequested':
      return true
    default:
      return false
  }
}

export function notificationFor(
  before: AgentSession | null,
  event: HookEvent,
  after: AgentSession,
): string | null {
  if (after.state !== 'waiting') return null
  // state_changed_at は ms 単位なので、同じ ms に続いた hook では新しい待ちでも前の行と同じ値になる。
  const stillWaiting = before?.state === 'waiting' && before.waitReason === after.waitReason
  switch (after.waitReason) {
    case 'idle': {
      const wasWorking = !before || before.state === 'running' || before.state === 'unobserved'
      return event.type === 'turnStopped' && wasWorking ? '手空き' : null
    }
    case 'question':
      return stillWaiting ? null : '質問'
    case 'permission':
      return event.type === 'permissionRequested' ? `許可: ${after.waitTool}` : null
    case 'error':
      if (stillWaiting) return null
      return after.errorType ? `エラー: ${after.errorType}` : 'エラー'
    default:
      return null
  }
}

// 1 つの Terminal Session で live な Agent Session は 1 つなので、そこで始まった session と、
// SessionStart を取りこぼしたまま live として入ってきた session は、先にいた live な行を終える。
export function takesOverTerminal(
  before: AgentSession | null,
  after: AgentSession | null,
  event: HookEvent,
): boolean {
  const liveThere = (row: AgentSession | null) =>
    row !== null && row.state !== 'ended' && row.terminalSessionId === event.terminalSessionId
  return event.type === 'sessionStarted' || (!liveThere(before) && liveThere(after))
}

export function supersede(row: AgentSession, now: Date): AgentSession {
  return enter(row, { state: 'ended', endReason: 'superseded', endedAt: now }, now)
}

function firstSeen(event: HookEvent, now: Date): AgentSession {
  return {
    sessionId: event.sessionId,
    terminalSessionId: event.terminalSessionId,
    state: 'running',
    ...CLEARED,
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    permissionMode: event.permissionMode,
    lastEventName: event.hookEventName,
    lastEventAt: now,
    stateChangedAt: now,
    firstSeenAt: now,
  }
}

function enter(row: AgentSession, fields: Partial<AgentSession>, now: Date): AgentSession {
  return { ...row, ...CLEARED, ...fields, stateChangedAt: now }
}
