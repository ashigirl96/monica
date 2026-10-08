import { useState } from 'react'

import { Answer } from './answer.tsx'
import { suggestions } from './answers.ts'
import { ChatScroll } from './chat-scroll.tsx'
import type { Chat } from './fake-chat.ts'
import { ChatMessage } from './fluid/chat-message.tsx'
import { InputMessage, type QueuedMessage } from './fluid/input-message.tsx'
import { ThinkingIndicatorJa } from './fluid/thinking-indicator-ja.tsx'
import { PageHeader } from './page-header.tsx'

export function VariantB({ chat }: { chat: Chat }) {
  const [draft, setDraft] = useState('')
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const history = chat.messages.filter((m) => m.from === 'user').map((m) => m.text)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="border-b border-border" />
      <ChatScroll contentClassName="flex flex-col gap-5 px-3 py-4">
        {chat.messages.length === 0 && (
          <p className="pt-10 text-center text-[13px] text-muted-foreground">
            開いているページについて質問できます
          </p>
        )}
        {chat.messages.map((m) =>
          m.from === 'user' ? (
            <ChatMessage key={m.id} from="user" className="max-w-[85%]">
              {m.text}
            </ChatMessage>
          ) : (
            <ChatMessage key={m.id} from="assistant" className="max-w-full">
              <Answer text={m.text} className="typeset" />
            </ChatMessage>
          ),
        )}
        {chat.phase === 'thinking' && <ThinkingIndicatorJa className="px-0" />}
      </ChatScroll>
      <div className="p-2">
        <InputMessage
          value={draft}
          onValueChange={setDraft}
          onSend={(text, _files, meta) => {
            chat.send(text)
            if (!meta?.queuedId) setDraft('')
          }}
          status={chat.phase === 'idle' ? 'idle' : 'streaming'}
          onStop={chat.stop}
          queue={queue}
          onQueueChange={setQueue}
          history={history}
          suggestions={suggestions}
          placeholder="このページについて質問"
          sendLabel="送る"
        />
      </div>
    </div>
  )
}
