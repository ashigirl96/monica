import { type PopoverAnchor, PopoverMenu, PopoverMenuItem, PopoverMenuSeparator } from '@monica/ui'
import { localTime } from '@monica/ui/local-time'
import { ChevronDown } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'

import type { ConversationSummary } from './conversation-store.ts'

const PARAM = 'conversation'

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

export function useSelectedConversation(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(PARAM),
    () => null,
  )
}

export const conversationPath = (studyId: string, conversationId: string | null) =>
  conversationId === null
    ? `/studies/${studyId}`
    : `/studies/${studyId}?${PARAM}=${encodeURIComponent(conversationId)}`

const startedLabel = (conversation: ConversationSummary) =>
  localTime(conversation.startedAt).slice(0, 16)

export function ConversationPicker({
  conversations,
  shown,
  canEnd,
  onPick,
  onNew,
}: {
  conversations: readonly ConversationSummary[]
  shown: ConversationSummary | null
  /** 許可で止まっていない turn の間は false。 */
  canEnd: boolean
  onPick: (conversation: ConversationSummary) => void
  onNew: () => void
}) {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const close = () => setAnchor(null)
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left })
        }}
        aria-label="会話を選ぶ"
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {shown === null ? '新しい会話' : `${startedLabel(shown)} の会話`}
        <ChevronDown className="size-3.5" strokeWidth={1.8} />
      </button>
      {anchor && (
        <PopoverMenu anchor={anchor} onClose={close} className="w-80">
          {conversations.map((conversation) => (
            <PopoverMenuItem
              key={conversation.id}
              onClick={() => {
                close()
                onPick(conversation)
              }}
              className={`flex-col items-start ${conversation.id === shown?.id ? 'bg-accent' : ''}`}
            >
              <span>{startedLabel(conversation)}</span>
              <span className="w-full truncate text-muted-foreground">
                {conversation.endedAt === null
                  ? '続いている会話'
                  : (conversation.summary ?? '終わった会話')}
              </span>
            </PopoverMenuItem>
          ))}
          {conversations.length > 0 && <PopoverMenuSeparator />}
          <PopoverMenuItem
            disabled={!canEnd}
            onClick={() => {
              close()
              onNew()
            }}
          >
            新しい会話を始める（今の会話は終わる）
          </PopoverMenuItem>
        </PopoverMenu>
      )}
    </>
  )
}
