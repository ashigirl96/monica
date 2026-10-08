import type { ReactNode } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

import { cn } from './fluid/lib/utils.ts'

export function ChatScroll({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <StickToBottom className={cn('relative min-h-0 flex-1', className)} resize="smooth" initial="instant">
      <StickToBottom.Content className={contentClassName}>{children}</StickToBottom.Content>
      <BackToLatest />
    </StickToBottom>
  )
}

function BackToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return (
    <button
      type="button"
      onClick={() => void scrollToBottom()}
      className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-surface-3 px-3 py-1 text-[12px] text-foreground shadow-surface-3"
    >
      ↓ 最新へ
    </button>
  )
}
