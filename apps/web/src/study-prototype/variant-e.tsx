// PROTOTYPE（Study の画面の試作、捨てる）: 案 E「Study は左、成果物は右」。D への対案。
// Study の一覧を別の画面にせず、左の欄にいつも置く。今の Study だけ開いて、その会話を並べる。
// 成果物の木と中身は右の欄に縦に並べ、押した所のすぐ下に中身を出す。Repo と Playground の command も右の欄の頭に置き、上の欄は名前と Tutor だけにする。
import { MessageCircle, PanelRight, Plus, ShieldAlert } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../../../packages/chat/src/ui/fluid/button.tsx'
import { InputMessage } from '../../../../packages/chat/src/ui/fluid/input-message.tsx'
import { actions, activeConversation, missionLine, pendingPermission, type Study, useStudies } from './data.ts'
import { go, LinkedRepos, ShellCommand, studyHref } from './parts.tsx'
import { ArtifactView, ChatColumn, MoreMenu } from './variant-a.tsx'
import { ArtifactTree } from './variant-b.tsx'
import { bucket, BUCKETS } from './variant-c.tsx'

function Sidebar({ current, selected, onSelect }: { current?: Study; selected?: string; onSelect?: (id: string) => void }) {
  const studies = [...useStudies()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return (
    <nav className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface-2 p-2">
      <Button size="compact" variant={current ? 'secondary' : 'primary'} leadingIcon={Plus} onClick={() => go(studyHref('/studies', 'E'))}>
        新しい Study
        <kbd className="ml-2 font-mono text-micro opacity-60">⌥N</kbd>
      </Button>
      {BUCKETS.map((g) => {
        const items = studies.filter((s) => bucket(s) === g)
        if (items.length === 0) return null
        return (
          <section key={g} className={g === 'しばらく触っていない' ? 'opacity-55' : ''}>
            <h2 className="mb-1 px-2 text-micro text-muted-foreground">{g}</h2>
            {items.map((s) => (
              <div key={s.id}>
                <button
                  type="button"
                  onClick={() => go(studyHref(`/studies/${s.short}`, 'E'))}
                  className={`flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left ${s.id === current?.id ? 'bg-selected' : 'hover:bg-hover'}`}
                >
                  <span className="line-clamp-2 flex-1 text-caption">{missionLine(s)}</span>
                  {pendingPermission(s) && <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" aria-label="許可を待っている" />}
                </button>
                {s.id === current?.id && (
                  <div className="my-1 ml-3 flex flex-col border-l border-border pl-1.5">
                    {[...s.conversations].reverse().map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onSelect?.(c.id)}
                        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-micro ${c.id === selected ? 'bg-hover text-foreground' : 'text-muted-foreground hover:bg-hover'}`}
                      >
                        <MessageCircle className="size-3 shrink-0" />
                        会話 {c.n}・{c.startedAt}
                        {!c.endedAt && <span className="text-[var(--success)]">●</span>}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        actions.newConversation(s.id)
                        onSelect?.(`c${s.conversations.length + 1}`)
                      }}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-micro text-muted-foreground hover:bg-hover"
                    >
                      <Plus className="size-3" />
                      新しい会話（今の会話は終わる）
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        )
      })}
    </nav>
  )
}

export function NewE() {
  const [draft, setDraft] = useState('')
  return (
    <div className="grid h-dvh grid-cols-[16rem_1fr]">
      <Sidebar />
      <main className="flex flex-col items-center justify-center px-6">
        <h1 className="mb-6 text-display font-semibold">何を学ぶ？</h1>
        <div className="w-full max-w-2xl">
          <InputMessage
            value={draft}
            onValueChange={setDraft}
            onSend={(t) => go(studyHref(`/studies/${actions.start(t)}`, 'E'))}
            placeholder="最初の一言から、Tutor と Mission を決める"
            sendLabel="始める"
            textareaProps={{ autoFocus: true }}
          />
        </div>
      </main>
    </div>
  )
}

export function ScreenE({ study }: { study: Study }) {
  const [selected, setSelected] = useState(activeConversation(study)?.id ?? study.conversations.at(-1)!.id)
  const [path, setPath] = useState('MISSION.md')
  const [panel, setPanel] = useState(true)
  const conversation = study.conversations.find((c) => c.id === selected) ?? study.conversations.at(-1)!

  return (
    <div className={`grid h-dvh ${panel ? 'grid-cols-[16rem_1fr_27rem]' : 'grid-cols-[16rem_1fr]'}`}>
      <Sidebar current={study} selected={conversation.id} onSelect={setSelected} />
      <div className="grid min-h-0 grid-rows-[auto_1fr]">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-subtitle font-medium">{missionLine(study)}</span>
          <span className="rounded-md bg-muted px-1.5 text-micro text-muted-foreground">Tutor: repository</span>
          <Button size="icon-sm" variant="ghost" aria-label="右の欄" active={panel} onClick={() => setPanel((p) => !p)}>
            <PanelRight />
          </Button>
          <MoreMenu study={study} after={studyHref('/studies', 'E')} />
        </header>
        <ChatColumn
          study={study}
          conversation={conversation}
          onOpen={(p) => {
            setPath(p)
            setPanel(true)
          }}
        />
      </div>
      {panel && (
        <aside className="flex min-h-0 flex-col border-l border-border">
          <div className="flex flex-col gap-2.5 border-b border-border p-3">
            <LinkedRepos study={study} />
            <ShellCommand study={study} />
          </div>
          <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border p-2">
            <ArtifactTree study={study} path={path} onOpen={setPath} />
          </div>
          <ArtifactView study={study} path={path} onOpen={setPath} />
        </aside>
      )}
    </div>
  )
}
