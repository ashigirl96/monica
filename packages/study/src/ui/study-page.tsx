import { InputMessage, ThinkingIndicator } from '@monica/ui/fluid'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import { createConversationStore } from './conversation-store.ts'
import { currentTutor, MessageView, TutorText } from './messages.tsx'
import { studiesKey } from './new-conversation.tsx'
import { LinkedRepos } from './repo-links.tsx'
import {
  FailureLine,
  nameOf,
  Screen,
  StudyName,
  useDocumentTitle,
  useNewConversationKey,
  useScreen,
} from './screen.tsx'

export function StudyPage({ id }: { id: string }) {
  const { client, navigate } = useScreen()
  const queryClient = useQueryClient()
  const store = useMemo(
    () =>
      createConversationStore(
        client,
        id,
        () => void queryClient.invalidateQueries({ queryKey: studiesKey }),
      ),
    [client, id, queryClient],
  )
  useEffect(() => store.open(), [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { study, messages, running, partialText, turnError, sendError } = snapshot
  const [draft, setDraft] = useState('')

  useDocumentTitle(study ? nameOf(study).text : null)
  useNewConversationKey(useCallback(() => navigate('/studies'), [navigate]))

  if (snapshot.missing) return <NoStudy />

  return (
    <Screen>
      <StudyHeader>
        {study && <StudyName study={study} className="min-w-0 flex-1 text-[15px] font-medium" />}
        <span className="shrink-0 text-[12px] text-muted-foreground">
          Tutor: {currentTutor(messages)}
        </span>
        <LinkedRepos id={id} />
      </StudyHeader>
      {/* column-reverse で、伸びる会話の下端に scroll が留まる。 */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-6">
          {study &&
            messages.map((message) => (
              <MessageView key={message.id} message={message} dir={study.dir} />
            ))}
          {running &&
            (partialText === '' ? <ThinkingIndicator /> : <TutorText text={partialText} />)}
          <FailureLine>{turnError}</FailureLine>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 px-4 pb-4">
        <FailureLine>{sendError}</FailureLine>
        <InputMessage
          value={draft}
          onValueChange={setDraft}
          onSend={(text) => {
            void store.send(text).then((sent) => sent && setDraft(''))
          }}
          placeholder="Tutor に話す"
          sendLabel="送る"
          textareaProps={{ autoFocus: true, 'aria-label': 'Tutor に話す' }}
        />
      </div>
    </Screen>
  )
}

function StudyHeader({ children }: { children?: ReactNode }) {
  const { spaLinkClick } = useScreen()
  return (
    <header className="flex items-center gap-3 border-b px-4 py-2.5">
      <a
        href="/studies"
        onClick={spaLinkClick('/studies')}
        aria-label="新しい会話（⌥N）"
        title="新しい会話（⌥N）"
        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="size-[18px]" strokeWidth={1.8} />
      </a>
      {children}
    </header>
  )
}

function NoStudy() {
  useDocumentTitle(null)
  return (
    <Screen>
      <StudyHeader />
      <p className="px-6 py-10 text-center text-muted-foreground">その Study は無い</p>
    </Screen>
  )
}

export function NoStudyPage() {
  const { navigate } = useScreen()
  useNewConversationKey(useCallback(() => navigate('/studies'), [navigate]))
  return <NoStudy />
}
