import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'

import type { Page } from '../contract.ts'
import { Answer } from './answer.tsx'
import { ChatScroll } from './chat-scroll.tsx'
import { type ChatClient, type ChatEntry, type ChatStore, createChatStore } from './chat-store.ts'
import { watchCurrentPage } from './current-page.ts'
import { ChatMessage } from './fluid/chat-message.tsx'
import { InputMessage } from './fluid/input-message.tsx'
import { ThinkingIndicator } from './fluid/thinking-indicator.tsx'
import { PageHeader } from './page-header.tsx'

function Reply({ entry }: { entry: ChatEntry }) {
  if (entry.status === 'waiting') return <ThinkingIndicator className="px-0" />
  if (entry.status === 'failed') {
    return (
      <ChatMessage from="assistant" className="max-w-full">
        <span className="text-muted-foreground">答えを受け取れませんでした</span>
      </ChatMessage>
    )
  }
  // 表とコードブロックは幅の計算から外してあるので、答えが表だけでも潰れないよう、吹き出しを幅いっぱいに伸ばす。
  return (
    <ChatMessage from="assistant" className="w-full max-w-full items-stretch">
      <Answer text={entry.answer} />
    </ChatMessage>
  )
}

function ChatBody({ store }: { store: ChatStore }) {
  const { entries, answering } = useSyncExternalStore(store.subscribe, store.snapshot)
  const [draft, setDraft] = useState('')

  return (
    <>
      <ChatScroll contentClassName="flex flex-col gap-5 px-3 py-4">
        {entries.length === 0 && (
          <p className="pt-10 text-center text-[13px] text-muted-foreground">
            このページについて質問できます
          </p>
        )}
        {entries.map((entry) => (
          <Fragment key={entry.id}>
            <ChatMessage from="user" className="max-w-[85%]">
              {entry.question}
            </ChatMessage>
            <Reply entry={entry} />
          </Fragment>
        ))}
      </ChatScroll>
      <div className="p-2">
        <InputMessage
          value={draft}
          onValueChange={setDraft}
          onSend={(question) => {
            if (store.ask(question)) setDraft('')
          }}
          status={answering ? 'streaming' : 'idle'}
          history={entries.map(({ question }) => question)}
          placeholder="このページについて質問"
          sendLabel="送る"
        />
      </div>
    </>
  )
}

/** side panel の Chat の画面。client はブラウザの口への chat の client。 */
export function ChatApp({ client }: { client: ChatClient }) {
  const [page, setPage] = useState<Page>()
  const [store] = useState(() => createChatStore(client))

  // side panel を閉じると document ごと Chat が終わる。片付けが走るのは dev の StrictMode の付け直しだけ。
  useEffect(() => {
    const watch = watchCurrentPage(setPage)
    store.open(watch.read)
    return () => {
      store.startNewChat()
      watch.stop()
    }
  }, [store])

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <PageHeader page={page} onNewChat={store.startNewChat} />
      <ChatBody store={store} />
    </div>
  )
}
