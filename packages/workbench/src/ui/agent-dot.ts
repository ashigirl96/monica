import type { AgentSession } from '../contract.ts'

export type AgentDot = 'question' | 'permission' | 'error' | 'idle' | 'unobserved' | 'running'

export const AGENT_DOT_STYLE: Record<AgentDot, { label: string; className: string }> = {
  question: { label: '質問', className: 'bg-amber-400 animate-pulse' },
  permission: { label: '許可', className: 'bg-amber-400 animate-pulse' },
  error: { label: 'エラー', className: 'bg-red-400' },
  idle: { label: '手空き', className: 'bg-amber-400/40' },
  unobserved: { label: '未観測', className: 'ring-1 ring-inset ring-zinc-400' },
  running: { label: '動作中', className: 'bg-emerald-400 animate-pulse' },
}

// Runspace の行は手を動かす必要が高いものから出す。質問と許可は同じ重さで、先の Tab が勝つ。
const RANK: Record<AgentDot, number> = {
  question: 0,
  permission: 0,
  error: 1,
  idle: 2,
  unobserved: 3,
  running: 4,
}

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

export function runspaceAgentDot(tabDots: (AgentDot | null)[]): AgentDot | null {
  let chosen: AgentDot | null = null
  for (const dot of tabDots) {
    if (dot && (!chosen || RANK[dot] < RANK[chosen])) chosen = dot
  }
  return chosen
}
