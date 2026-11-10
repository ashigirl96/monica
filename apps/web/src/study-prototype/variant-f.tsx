// PROTOTYPE（Study の画面の試作、捨てる）: 案 F「表紙と会話」。D への対案。
// Study を開くと、まず表紙（Mission・学んだこと・会話・この Study の設定）に着く。表紙の入力欄に打つと会話の画面に移る。
// 会話の画面は幅いっぱいの 1 列で、常に出す欄は無い。成果物は表紙でも会話でも右から出す引き出し（C）で読む。
import { ArrowLeft, ChevronRight, Library, ShieldAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Button } from '../../../../packages/chat/src/ui/fluid/button.tsx'
import { InputMessage } from '../../../../packages/chat/src/ui/fluid/input-message.tsx'
import { actions, activeConversation, type Message, missionLine, pendingPermission, type Study } from './data.ts'
import { artifactLabel, go, LinkedRepos, MessageList, Prose, ShellCommand, studyHref } from './parts.tsx'
import { MoreMenu } from './variant-a.tsx'
import { ConversationPicker, Drawer, PermissionDone, PermissionPrompt } from './variant-c.tsx'

function recordTitle(study: Study, path: string): string {
  return study.artifacts[path]?.split('\n')[0]?.replace(/^#\s*/, '') ?? path
}

function Cover({ study, onChat, onOpen }: { study: Study; onChat: (id?: string) => void; onOpen: (p: string) => void }) {
  const [draft, setDraft] = useState('')
  const active = activeConversation(study)
  const pending = pendingPermission(study)
  const records = Object.keys(study.artifacts).filter((p) => p.startsWith('learning-records/')).sort()
  const side = (label: string, children: ReactNode) => (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-micro text-muted-foreground">{label}</h2>
      {children}
    </section>
  )
  return (
    <div className="h-dvh overflow-y-auto">
      <header className="flex items-center justify-between px-4 py-2.5">
        <button type="button" onClick={() => go(studyHref('/studies', 'F'))} className="text-micro text-muted-foreground hover:text-foreground">
          ← Study の一覧
        </button>
        <MoreMenu study={study} after={studyHref('/studies', 'F')} />
      </header>
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_17rem] gap-12 px-8 pt-6 pb-24">
        <main className="flex min-w-0 flex-col gap-8">
          <Prose text={study.artifacts['MISSION.md'] ?? ''} from="MISSION.md" onOpen={onOpen} className="text-[15px] [&_h1]:text-display" />

          <div className="flex flex-col gap-2">
            {pending && (
              <button
                type="button"
                onClick={() => onChat(active?.id)}
                className="flex items-center gap-2 rounded-xl bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] px-3 py-2 text-left text-caption ring-1 ring-[var(--warning)]"
              >
                <ShieldAlert className="size-3.5 shrink-0" />
                会話 {active?.n} で Tutor が許可を待っている。答えるまで止まっている。
                <ChevronRight className="ml-auto size-3.5" />
              </button>
            )}
            <InputMessage
              value={draft}
              onValueChange={setDraft}
              onSend={(t) => {
                if (!active) actions.newConversation(study.id)
                actions.send(study.id, t)
                onChat(active?.id ?? `c${study.conversations.length + 1}`)
              }}
              placeholder={active ? `会話 ${active.n} を続ける` : '新しい会話を始める'}
              sendLabel="送る"
            />
          </div>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1 text-subtitle font-medium">学んだこと</h2>
            {records.length === 0 && <p className="text-caption text-muted-foreground">学習記録はまだ無い。</p>}
            {records.map((p) => (
              <button key={p} type="button" onClick={() => onOpen(p)} className="flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                <span className="font-mono text-micro text-muted-foreground">{p.slice(17, 21)}</span>
                <span className="text-body">{recordTitle(study, p).replace(/^\d+\s*/, '')}</span>
              </button>
            ))}
          </section>
        </main>

        <aside className="flex flex-col gap-6 pt-2">
          {side(
            '会話',
            <div className="flex flex-col">
              {[...study.conversations].reverse().map((c) => (
                <button key={c.id} type="button" onClick={() => onChat(c.id)} className="flex flex-col rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                  <span className="text-caption">
                    会話 {c.n}・{c.startedAt}
                    {!c.endedAt && <span className="ml-1 text-[var(--success)]">● 続いている</span>}
                  </span>
                  {c.reflection && <span className="line-clamp-2 text-micro text-muted-foreground">{c.reflection.replace(/`/g, '')}</span>}
                </button>
              ))}
            </div>,
          )}
          {side(
            '資料',
            <div className="flex flex-col">
              {['RESOURCES.md', 'GLOSSARY.md', 'log.md']
                .filter((p) => study.artifacts[p] !== undefined)
                .map((p) => (
                  <button key={p} type="button" onClick={() => onOpen(p)} className="rounded-lg px-2 py-1 text-left text-caption hover:bg-hover">
                    {artifactLabel(p)}
                  </button>
                ))}
            </div>,
          )}
          {side('紐付けた Repo', <LinkedRepos study={study} />)}
          {side(`Playground に入る（${study.playground}）`, <ShellCommand study={study} />)}
          <span className="text-micro text-muted-foreground">Tutor: repository</span>
        </aside>
      </div>
    </div>
  )
}

export function ScreenF({ study }: { study: Study }) {
  const [chat, setChat] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const conversation = study.conversations.find((c) => c.id === chat)
  const pending = conversation?.messages.find((m): m is Extract<Message, { kind: 'permission' }> => m.kind === 'permission' && m.state === 'pending')

  return (
    <>
      {!conversation ? (
        <Cover study={study} onChat={(id) => setChat(id ?? study.conversations.at(-1)!.id)} onOpen={setDrawer} />
      ) : (
        <div className="flex h-dvh flex-col">
          <header className="flex items-center gap-2 px-4 py-2.5">
            <Button size="compact" variant="ghost" leadingIcon={ArrowLeft} onClick={() => setChat(null)}>
              表紙
            </Button>
            <span className="min-w-0 truncate text-caption text-muted-foreground">{missionLine(study)}</span>
            <ConversationPicker study={study} selected={conversation} onSelect={setChat} />
            <span className="rounded-md bg-muted px-1.5 text-micro text-muted-foreground">Tutor: repository</span>
            <Button size="compact" variant="ghost" leadingIcon={Library} className="ml-auto" onClick={() => setDrawer(drawer ? null : 'MISSION.md')}>
              成果物
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
              <MessageList messages={conversation.messages} thinking={conversation.thinking} onOpen={setDrawer} permission={(m) => <PermissionDone m={m} />} />
              {conversation.reflection && (
                <div className="flex flex-col gap-1 border-t border-border pt-3">
                  <span className="text-micro text-muted-foreground">振り返り</span>
                  <Prose text={conversation.reflection} />
                </div>
              )}
            </div>
          </div>
          <div className="mx-auto w-full max-w-2xl px-6 pb-5">
            {conversation.endedAt ? (
              <p className="py-3 text-center text-caption text-muted-foreground">この会話は終わっている。続きは表紙から始める。</p>
            ) : pending ? (
              <PermissionPrompt study={study} m={pending} />
            ) : (
              <InputMessage
                value={draft}
                onValueChange={setDraft}
                onSend={(t) => {
                  actions.send(study.id, t)
                  setDraft('')
                }}
                placeholder="Tutor に話す"
                sendLabel="送る"
              />
            )}
          </div>
        </div>
      )}
      {drawer && <Drawer study={study} path={drawer} onOpen={setDrawer} onClose={() => setDrawer(null)} />}
    </>
  )
}
