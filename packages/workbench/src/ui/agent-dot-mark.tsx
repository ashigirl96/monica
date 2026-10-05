import { cn } from '@tania/ui'

import { AGENT_DOT_STYLE, type AgentDot } from './agent-dot.ts'

export function AgentDotMark({ dot, className }: { dot: AgentDot | null; className?: string }) {
  if (!dot) return null
  const style = AGENT_DOT_STYLE[dot]
  return (
    <span
      title={style.label}
      className={cn('size-1.5 shrink-0 rounded-full', style.className, className)}
    />
  )
}
