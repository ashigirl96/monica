import type { ReactNode } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

/** 答えの流れる下端に張り付き、上へスクロールすると外れて「最新へ」を出す。 */
export function ChatScroll({
  children,
  contentClassName,
}: {
  children: ReactNode
  contentClassName?: string
}) {
  return (
    <StickToBottom className="relative min-h-0 flex-1" resize="smooth" initial="instant">
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
      className="bg-surface-3 shadow-surface-3 absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[12px] text-foreground"
    >
      ↓ 最新へ
    </button>
  )
}
