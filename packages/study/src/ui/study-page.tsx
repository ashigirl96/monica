import { pushErrorToast, pushInfoToast } from '@monica/ui'
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

import { shortIdOf } from '../contract.ts'
import { ArtifactPanel, artifactKey, artifactsKey, ArtifactTree } from './artifact-view.tsx'
import {
  ConversationPicker,
  conversationPath,
  useSelectedConversation,
} from './conversation-picker.tsx'
import { createConversationStore } from './conversation-store.ts'
import { currentTutor, MessageView, PermissionPrompt, TutorText } from './messages.tsx'
import { studiesKey } from './new-conversation.tsx'
import { StudyMenu } from './remove-study.tsx'
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
        (path) => {
          void queryClient.invalidateQueries({ queryKey: artifactsKey(id) })
          void queryClient.invalidateQueries({ queryKey: artifactKey(id, path) })
        },
      ),
    [client, id, queryClient],
  )
  const [openPath, setOpenPath] = useState<string | null>(null)
  useEffect(() => store.open(), [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { study, messages, permission, running, partialText, turnError, sendError } = snapshot
  const { conversations, shown, ongoingId } = snapshot
  const [draft, setDraft] = useState('')
  const selected = useSelectedConversation()
  useEffect(() => store.select(selected), [store, selected])
  // 続いている会話があるのに終わった会話を開いた時は、送ると別の会話に入るので入力欄を出さない。
  const viewingPast = shown !== null && shown.endedAt !== null && ongoingId !== null

  useDocumentTitle(study ? nameOf(study).text : null)
  useNewConversationKey(useCallback(() => navigate('/studies'), [navigate]))

  if (snapshot.missing) return <NoStudy />

  return (
    <Screen>
      <StudyHeader>
        {study && <StudyName study={study} className="min-w-0 flex-1 text-[15px] font-medium" />}
        <ShellCommand studyId={id} />
        <span className="shrink-0 text-[12px] text-muted-foreground">
          Tutor: {currentTutor(messages)}
        </span>
        <ConversationPicker
          conversations={conversations}
          shown={shown}
          canEnd={!running || permission !== null}
          onPick={(conversation) =>
            navigate(conversationPath(id, conversation.id === ongoingId ? null : conversation.id))
          }
          onNew={() => {
            navigate(conversationPath(id, null))
            void store.end()
          }}
        />
        <LinkedRepos id={id} />
        <StudyMenu id={id} />
      </StudyHeader>
      <div className="flex min-h-0 flex-1">
        <ArtifactTree id={id} selected={openPath} onSelect={setOpenPath} />
        <section className="flex min-w-0 flex-1 flex-col">
          {/* column-reverse で、伸びる会話の下端に scroll が留まる。 */}
          <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-6">
              {study &&
                messages.map((message) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    dir={study.dir}
                    onOpenArtifact={setOpenPath}
                  />
                ))}
              {running &&
                (partialText !== '' ? (
                  <TutorText text={partialText} />
                ) : (
                  permission === null && <ThinkingIndicator />
                ))}
              <FailureLine>{turnError}</FailureLine>
            </div>
          </div>
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 px-4 pb-4">
            <FailureLine>{sendError}</FailureLine>
            {permission ? (
              <PermissionPrompt
                key={permission.id}
                permission={permission}
                onAnswer={(allow) => void store.answer(permission.id, allow)}
              />
            ) : viewingPast ? (
              <button
                type="button"
                onClick={() => navigate(conversationPath(id, null))}
                className="self-center rounded-lg px-3 py-1.5 text-[14px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                続いている会話に戻る
              </button>
            ) : (
              <InputMessage
                value={draft}
                onValueChange={setDraft}
                disabled={running}
                onSend={(text) => {
                  void store.send(text).then((sent) => {
                    if (!sent) return
                    setDraft('')
                    if (selected !== null) navigate(conversationPath(id, null))
                  })
                }}
                placeholder="Tutor に話す"
                sendLabel="送る"
                textareaProps={{ autoFocus: true, 'aria-label': 'Tutor に話す' }}
              />
            )}
          </div>
        </section>
        {study && openPath !== null && (
          <ArtifactPanel
            id={id}
            dir={study.dir}
            path={openPath}
            onOpenArtifact={setOpenPath}
            onClose={() => setOpenPath(null)}
          />
        )}
      </div>
    </Screen>
  )
}

export function ShellCommand({ studyId }: { studyId: string }) {
  const command = `monica study shell ${shortIdOf(studyId)}`
  return (
    <button
      type="button"
      title="写す"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(
          () => pushInfoToast(`写した: ${command}`),
          (error: unknown) => pushErrorToast(`写せなかった: ${(error as Error).message}`),
        )
      }}
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <code className="font-mono">{command}</code>
    </button>
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
