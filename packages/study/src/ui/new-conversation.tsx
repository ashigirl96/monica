import { InputMessage } from '@monica/ui/fluid'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

import { failureLine, type StudyClient } from './client.ts'
import { createStudyStarter } from './new-study.ts'
import { activityTime, groupByRecency } from './recency.ts'
import {
  FailureLine,
  Screen,
  StudyName,
  useDocumentTitle,
  useNewConversationKey,
  useScreen,
} from './screen.tsx'

export const studiesKey = ['studies'] as const

export function NewConversation() {
  const { client, navigate } = useScreen()
  const queryClient = useQueryClient()
  const [starter] = useState(() => createStudyStarter(client))
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const composer = useRef<HTMLDivElement>(null)

  useDocumentTitle('新しい会話')
  useNewConversationKey(useCallback(() => composer.current?.querySelector('textarea')?.focus(), []))

  async function begin(text: string) {
    try {
      const id = await starter.begin(text)
      void queryClient.invalidateQueries({ queryKey: studiesKey })
      navigate(`/studies/${id}`)
    } catch (error) {
      setFailure(failureLine(error))
    }
  }

  return (
    <Screen>
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4 px-4 pt-10 pb-4">
        <header className="flex flex-col gap-1 px-1">
          <h1 className="text-[22px] font-semibold">新しい会話</h1>
          <p className="text-[13px] text-muted-foreground">
            下に打つと新しい Study を始める。続きなら Study を選ぶ。
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StudyList />
        </div>
        <div className="flex flex-col gap-1.5">
          <FailureLine>{failure}</FailureLine>
          <InputMessage
            ref={composer}
            value={draft}
            onValueChange={setDraft}
            onSend={(text) => void begin(text)}
            placeholder="何を学ぶ？（最初の一言から、Tutor と Mission を決める）"
            sendLabel="始める"
            textareaProps={{ autoFocus: true, 'aria-label': '最初の一言' }}
          />
        </div>
      </div>
    </Screen>
  )
}

function StudyList() {
  const { client } = useScreen()
  const { data, dataUpdatedAt } = useQuery({
    queryKey: studiesKey,
    queryFn: () => client.list({}),
  })
  if (data === undefined) return null
  if (data.studies.length === 0) {
    return <p className="px-1 text-[13px] text-muted-foreground">Study はまだ無い</p>
  }
  const now = new Date(dataUpdatedAt)
  return (
    <div className="flex flex-col gap-5">
      {groupByRecency(data.studies, now).map(({ section, label, items }) => (
        <section key={section} className={section === 'stale' ? 'opacity-55' : undefined}>
          <h2 className="px-1 pb-1 text-[12px] font-medium text-muted-foreground">{label}</h2>
          <ul className="flex flex-col">
            {items.map((study) => (
              <StudyRow key={study.id} study={study} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

type ListedStudy = Awaited<ReturnType<StudyClient['list']>>['studies'][number]

export function StudyRow({ study, now }: { study: ListedStudy; now: Date }) {
  const { spaLinkClick } = useScreen()
  return (
    <li>
      <a
        href={`/studies/${study.id}`}
        onClick={spaLinkClick(`/studies/${study.id}`)}
        className="flex flex-col gap-0.5 rounded-lg px-2 py-2 hover:bg-muted"
      >
        <StudyName study={study} className="text-[15px]" />
        <span className="flex gap-2 text-[12px] text-muted-foreground">
          <span className="shrink-0 tabular-nums">{activityTime(study.lastActivityAt, now)}</span>
          {study.playgroundRemoved && <span className="shrink-0">Playground は消えた</span>}
          {study.lastLogLine !== null && <span className="truncate">{study.lastLogLine}</span>}
        </span>
      </a>
    </li>
  )
}
