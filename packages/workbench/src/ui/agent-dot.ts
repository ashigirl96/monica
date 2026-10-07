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

// 未読の印は白にそろえ、dot の緑・琥珀・赤と重ねない。
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
