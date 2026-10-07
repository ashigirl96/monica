import type { AgentSession } from '../contract.ts'

export type AgentDot = 'question' | 'permission' | 'error' | 'idle' | 'unobserved' | 'running'

export const AGENT_DOT_STYLE: Record<AgentDot, { label: string; className: string }> = {
  question: { label: '質問', className: 'bg-amber-400 animate-pulse' },
  permission: { label: '許可', className: 'bg-amber-400 animate-pulse' },
  error: { label: 'エラー', className: 'bg-red-400' },
  idle: { label: '手空き', className: 'bg-zinc-500' },
  unobserved: { label: '未観測', className: 'ring-1 ring-inset ring-zinc-400' },
  running: { label: '動作中', className: 'bg-emerald-400 animate-pulse' },
}

// dot は色ごとに数えるので、同じ琥珀の質問と許可は 1 つに数える。
export type AgentTallyKind = 'running' | 'questionOrPermission' | 'error' | 'idle' | 'unobserved'

export type AgentTally = { kind: AgentTallyKind; count: number }

const TALLY_KIND_OF: Record<AgentDot, AgentTallyKind> = {
  running: 'running',
  question: 'questionOrPermission',
  permission: 'questionOrPermission',
  error: 'error',
  idle: 'idle',
  unobserved: 'unobserved',
}

const TALLY_ORDER: AgentTallyKind[] = [
  'running',
  'questionOrPermission',
  'error',
  'idle',
  'unobserved',
]

export const AGENT_TALLY_STYLE: Record<AgentTallyKind, { label: string; className: string }> = {
  running: AGENT_DOT_STYLE.running,
  questionOrPermission: { label: '質問・許可', className: AGENT_DOT_STYLE.question.className },
  error: AGENT_DOT_STYLE.error,
  idle: AGENT_DOT_STYLE.idle,
  unobserved: AGENT_DOT_STYLE.unobserved,
}

export function agentTallyLabel({ kind, count }: AgentTally): string {
  return `${AGENT_TALLY_STYLE[kind].label}の Tab ${count}`
}

export function tallyAgentDots(dots: (AgentDot | null)[]): AgentTally[] {
  const counts = new Map<AgentTallyKind, number>()
  for (const dot of dots) {
    if (!dot) continue
    const kind = TALLY_KIND_OF[dot]
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return TALLY_ORDER.flatMap((kind) => {
    const count = counts.get(kind)
    return count ? [{ kind, count }] : []
  })
}

// 未読の印は白にそろえ、dot の緑・琥珀・赤・灰と重ねない。
export const UNREAD_DOT_STYLE =
  'animate-none outline-[1.5px] outline-offset-[1.5px] outline-zinc-50'
export const UNREAD_LABEL_STYLE = 'font-[650] text-zinc-50'

export function agentDotOf(agentSession: AgentSession | undefined): AgentDot | null {
  switch (agentSession?.state) {
    case 'running':
    case 'unobserved':
      return agentSession.state
    case 'waiting':
      return agentSession.waitReason
    default:
      return null
  }
}
