import { cn } from '@tania/ui'

import { AGENT_DOT_STYLE, type AgentDot, UNREAD_DOT_STYLE } from './agent-dot.ts'

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
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        style.className,
        unread && UNREAD_DOT_STYLE,
        className,
      )}
    />
  )
}
