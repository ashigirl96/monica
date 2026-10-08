import { useState } from 'react'

import { Answer } from './answer.tsx'
import { suggestions } from './answers.ts'
import { ChatScroll } from './chat-scroll.tsx'
import type { Chat } from './fake-chat.ts'
import { ChatMessage } from './fluid/chat-message.tsx'
import { InputMessage, type QueuedMessage } from './fluid/input-message.tsx'
import { ThinkingIndicator } from './fluid/thinking-indicator.tsx'
import { PageHeader } from './page-header.tsx'

export function VariantA({ chat }: { chat: Chat }) {
  const [draft, setDraft] = useState('')
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const history = chat.messages.filter((m) => m.from === 'user').map((m) => m.text)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="border-b border-border" />
      <ChatScroll contentClassName="flex flex-col gap-4 px-3 py-4">
        {chat.messages.map((m) =>
          m.from === 'user' ? (
            <ChatMessage key={m.id} from="user">
              {m.text}
            </ChatMessage>
          ) : (
            <ChatMessage key={m.id} from="assistant">
              <Answer text={m.text} className="typeset" />
            </ChatMessage>
          ),
        )}
        {chat.phase === 'thinking' && <ThinkingIndicator />}
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
        />
      </div>
    </div>
  )
}
