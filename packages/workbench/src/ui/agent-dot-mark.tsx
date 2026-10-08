import { cn } from '@monica/ui'

import {
  AGENT_DOT_STYLE,
  AGENT_TALLY_STYLE,
  type AgentDot,
  type AgentTally,
  agentTallyLabel,
  UNREAD_DOT_STYLE,
} from './agent-dot.ts'

const DOT_SHAPE = 'size-1.5 shrink-0 rounded-full'

export function AgentDotMark({
  dot,
  unread = false,
  className,
}: {
  dot: AgentDot | null
  unread?: boolean
  className?: string
}) {
  if (!dot) return null
  const style = AGENT_DOT_STYLE[dot]
  return (
    <span
      title={style.label}
      className={cn(DOT_SHAPE, style.className, unread && UNREAD_DOT_STYLE, className)}
    />
  )
}

export function AgentTallyMark({ tally }: { tally: AgentTally }) {
  return (
    <span title={agentTallyLabel(tally)} className="flex shrink-0 items-center gap-1">
      <span className={cn(DOT_SHAPE, AGENT_TALLY_STYLE[tally.kind].className)} />
      <span className="text-[10.5px] text-white/70 tabular-nums">{tally.count}</span>
    </span>
  )
}
