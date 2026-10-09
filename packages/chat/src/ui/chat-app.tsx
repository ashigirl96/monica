import { Camera } from 'lucide-react'
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'

import { Answer } from './answer.tsx'
import { ChatScroll } from './chat-scroll.tsx'
import { type ChatClient, type ChatEntry, type ChatStore, createChatStore } from './chat-store.ts'
import { type CurrentPage, watchCurrentPage } from './current-page.ts'
import { Button } from './fluid/button.tsx'
import { ChatMessage } from './fluid/chat-message.tsx'
import { InputMessage } from './fluid/input-message.tsx'
import { useIcons } from './fluid/lib/icon-context.tsx'
import { ThinkingIndicator } from './fluid/thinking-indicator.tsx'
import { PageHeader } from './page-header.tsx'
import { readCurrentPage } from './read-current-page.ts'

function Faint({ children }: { children: string }) {
  return <p className="text-[13px] leading-5 text-muted-foreground">{children}</p>
}

function FailureLines({ entry, onRetry }: { entry: ChatEntry; onRetry: (() => void) | undefined }) {
  const icons = useIcons()
  if (!entry.failure) return null
  const { line, detail } = entry.failure
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-[13px] leading-5 text-destructive">{line}</p>
      {detail && (
        <p className="font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground">
          {detail}
        </p>
      )}
      {onRetry && (
        <Button
          variant="secondary"
          size="compact"
          leadingIcon={icons['rotate-ccw']}
          onClick={onRetry}
        >
          再試行
        </Button>
      )}
    </div>
  )
}

function Reply({ entry, onRetry }: { entry: ChatEntry; onRetry: (() => void) | undefined }) {
  if (entry.status === 'waiting') return <ThinkingIndicator className="px-0" />
  if (entry.retrying) {
    return (
      <ChatMessage from="assistant" className="max-w-full">
        <Faint>{entry.retrying}</Faint>
      </ChatMessage>
    )
  }
  // 表とコードブロックは幅の計算から外してあるので、答えが表だけでも潰れないよう、吹き出しを幅いっぱいに伸ばす。
  return (
    <ChatMessage from="assistant" className="w-full max-w-full items-stretch">
      <div className="flex flex-col gap-2">
        {entry.answer && <Answer text={entry.answer} />}
        {entry.status === 'stopped' && <Faint>止めました</Faint>}
        <FailureLines entry={entry} onRetry={onRetry} />
        {entry.usage && <Faint>{entry.usage}</Faint>}
      </div>
    </ChatMessage>
  )
}

function ScreenshotToggle({ store, pressed }: { store: ChatStore; pressed: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      active={pressed}
      aria-pressed={pressed}
      aria-label="スクリーンショットを添える"
      title="スクリーンショットを添える"
      className={pressed ? 'text-foreground' : undefined}
      // 押した後の Enter が、このボタンを押し直さずに質問を送るよう、focus を入力欄に残す。
      onMouseDown={(event) => event.preventDefault()}
      onClick={store.toggleScreenshot}
    >
      <Camera />
    </Button>
  )
}

function ChatBody({ store }: { store: ChatStore }) {
  const { entries, answering, withScreenshot, unreachable, retryable } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
  )
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
            <div className="flex flex-col items-end gap-1">
              {entry.screenshot !== undefined && (
                // manifest の CSP の img-src は 'self' と data: だけを通すので、data: の URL で描く。
                <img
                  src={`data:image/jpeg;base64,${entry.screenshot}`}
                  alt="添えたスクリーンショット"
                  className="max-w-[160px] rounded-md border border-border"
                />
              )}
              <ChatMessage from="user" className="max-w-[85%]">
                {entry.question}
              </ChatMessage>
              {entry.notice && (
                <p className="max-w-[85%] text-right text-[11px] leading-4 text-muted-foreground">
                  {entry.notice}
                </p>
              )}
            </div>
            <Reply entry={entry} onRetry={entry.id === retryable ? store.retry : undefined} />
          </Fragment>
        ))}
      </ChatScroll>
      <div className="flex flex-col gap-1.5 p-2">
        {unreachable && (
          <p
            role="status"
            className="bg-destructive-light rounded-md px-3 py-1.5 text-[12px] leading-4 text-destructive"
          >
            monica の desktop が起動していません
          </p>
        )}
        <InputMessage
          value={draft}
          onValueChange={setDraft}
          onSend={(question) => {
            if (store.ask(question)) setDraft('')
          }}
          status={answering ? 'streaming' : 'idle'}
          onStop={store.stop}
          leftSlot={<ScreenshotToggle store={store} pressed={withScreenshot} />}
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
  const [page, setPage] = useState<CurrentPage>()
  const [store] = useState(() => createChatStore(client))

  // side panel を閉じると document ごと Chat が終わる。片付けが走るのは dev の StrictMode の付け直しだけ。
  useEffect(() => {
    const watch = watchCurrentPage(setPage)
    // 質問を送った時に、その時の Browser Tab を読む。side panel を開いているだけでは読まない。
    const close = store.open((options) => readCurrentPage(watch, options), window)
    return () => {
      close()
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
