import { useState } from 'react'

import { Answer } from './answer.tsx'
import { ChatScroll } from './chat-scroll.tsx'
import type { Chat, Message } from './fake-chat.ts'
import { InputMessage } from './fluid/input-message.tsx'
import { ThinkingIndicatorJa } from './fluid/thinking-indicator-ja.tsx'
import { PageHeader } from './page-header.tsx'

interface Turn {
  id: string
  question: string
  answer?: string
}

function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.from === 'user') turns.push({ id: m.id, question: m.text })
    else {
      const last = turns.at(-1)
      if (last) last.answer = m.text
    }
  }
  return turns
}

export function VariantC({ chat }: { chat: Chat }) {
  const [draft, setDraft] = useState('')
  const turns = toTurns(chat.messages)
  const busy = chat.phase !== 'idle'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatScroll contentClassName="px-4 pb-6">
        <PageHeader className="px-0 pt-3" />
        {turns.map((t, i) => (
          <section key={t.id} className="mt-4 border-t border-border pt-4">
            <p className="border-l-2 border-foreground/20 pl-2 text-[13px] leading-5 text-muted-foreground">
              {t.question}
            </p>
            {t.answer !== undefined ? (
              <Answer text={t.answer} className="typeset mt-3 text-foreground" />
            ) : i === turns.length - 1 && chat.phase === 'thinking' ? (
              <ThinkingIndicatorJa showIcon={false} className="px-0 py-2" />
            ) : (
              <p className="mt-3 text-[12px] text-muted-foreground">止めました</p>
            )}
          </section>
        ))}
      </ChatScroll>
      <div className="border-t border-border p-2">
        <InputMessage
          size="compact"
          value={draft}
          onValueChange={setDraft}
          onSend={(text) => {
            if (busy) return
            chat.send(text)
            setDraft('')
          }}
          status={busy ? 'streaming' : 'idle'}
          onStop={chat.stop}
          maxRows={5}
          placeholder="このページについて質問"
        />
      </div>
    </div>
  )
}
