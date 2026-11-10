// PROTOTYPE（Study の画面の試作、捨てる）: 案 A「会話が真ん中」。
// 名前は Mission の 1 行目。終わりの状態は持たず、消すだけ。会話は左の一覧、成果物は右の欄の tab。許可は会話の中の欄。
import { ArrowLeft, ExternalLink, MoreHorizontal, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../../../packages/chat/src/ui/fluid/button.tsx'
import { InputMessage } from '../../../../packages/chat/src/ui/fluid/input-message.tsx'
import { actions, activeConversation, type Conversation, type Message, missionLine, pendingPermission, type Study, useStudies } from './data.ts'
import {
  artifactLabel,
  artifactPaths,
  DELETED_THINGS,
  Dialog,
  go,
  LinkedRepos,
  MessageList,
  Prose,
  ShellCommand,
  studyHref,
} from './parts.tsx'

export function ListA() {
  const studies = useStudies()
  const [mission, setMission] = useState('')
  return (
    <div className="mx-auto w-full max-w-4xl px-8 pt-16 pb-24">
      <div className="mb-6 flex items-end justify-between">
        <h1 className="text-display font-semibold">Study</h1>
      </div>
      <form
        className="mb-8 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!mission.trim()) return
          go(studyHref(`/studies/${actions.start(mission.trim())}`, 'A'))
        }}
      >
        <input
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          placeholder="何を学びたいか（Tutor と Mission を決める最初の一言）"
          className="flex-1 rounded-xl bg-surface-3 px-3 py-2 text-body shadow-surface-2 outline-none"
        />
        <Button type="submit" variant="primary">
          始める
        </Button>
      </form>
      <div className="flex flex-col">
        <div className="grid grid-cols-[1fr_12rem_6rem_6rem] gap-4 border-b border-border px-3 pb-2 text-micro text-muted-foreground">
          <span>Mission</span>
          <span>紐付けた Repo</span>
          <span>会話</span>
          <span className="text-right">最後</span>
        </div>
        {[...studies]
          .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
          .map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => go(studyHref(`/studies/${s.short}`, 'A'))}
              className="grid grid-cols-[1fr_12rem_6rem_6rem] items-center gap-4 rounded-lg px-3 py-2.5 text-left hover:bg-hover"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-subtitle">{missionLine(s)}</span>
                {pendingPermission(s) && (
                  <span className="flex shrink-0 items-center gap-1 rounded-md bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] px-1.5 text-micro">
                    <ShieldAlert className="size-3" />
                    許可を待っている
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-caption text-muted-foreground">{s.linkedRepos.join(', ') || '—'}</span>
              <span className="text-caption text-muted-foreground">
                {s.conversations.length} 本{activeConversation(s) ? '・続いている' : ''}
              </span>
              <span className="text-right text-caption text-muted-foreground">{s.lastActivityLabel}</span>
            </button>
          ))}
      </div>
    </div>
  )
}

function PermissionCard({ study, m }: { study: Study; m: Extract<Message, { kind: 'permission' }> }) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-xl p-3 ${
        m.state === 'pending' ? 'bg-surface-3 shadow-surface-3 ring-1 ring-[var(--warning)]' : 'bg-muted'
      }`}
    >
      <div className="flex items-center gap-1.5 text-caption font-medium">
        <ShieldAlert className="size-3.5" />
        箱の外で走らせる許可
        {m.state !== 'pending' && (
          <span className="ml-auto text-micro text-muted-foreground">{m.state === 'allowed' ? '許した' : '断った'}</span>
        )}
      </div>
      <pre className="overflow-x-auto rounded-lg bg-background px-2.5 py-2 font-mono text-caption whitespace-pre-wrap">{m.command}</pre>
      <p className="text-caption text-muted-foreground">{m.reason}</p>
      {m.state === 'pending' && (
        <div className="flex gap-2">
          <Button size="compact" variant="primary" onClick={() => actions.answer(study.id, m.id, true)}>
            許す
          </Button>
          <Button size="compact" variant="secondary" onClick={() => actions.answer(study.id, m.id, false)}>
            断る
          </Button>
        </div>
      )}
    </div>
  )
}

export function ArtifactView({ study, path, onOpen }: { study: Study; path: string; onOpen: (p: string) => void }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Prose text={study.artifacts[path] ?? '（無い）'} from={path} onOpen={onOpen} />
      </div>
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="truncate font-mono text-micro text-muted-foreground">~/.monica/studies/{study.id.slice(0, 14)}…/{path}</span>
        <Button size="compact" variant="ghost" leadingIcon={ExternalLink} className="shrink-0">
          エディタで開く
        </Button>
      </div>
    </>
  )
}

function ArtifactPane({ study, path, onOpen }: { study: Study; path: string; onOpen: (p: string) => void }) {
  const paths = artifactPaths(study)
  return (
    <aside className="flex min-h-0 flex-col border-l border-border">
      <div className="flex flex-wrap gap-1 border-b border-border p-2">
        {paths.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onOpen(p)}
            className={`rounded-md px-2 py-1 text-caption ${p === path ? 'bg-selected text-foreground' : 'text-muted-foreground hover:bg-hover'}`}
          >
            {artifactLabel(p)}
          </button>
        ))}
      </div>
      <ArtifactView study={study} path={path} onOpen={onOpen} />
    </aside>
  )
}

export function ChatColumn({ study, conversation, onOpen }: { study: Study; conversation: Conversation; onOpen: (p: string) => void }) {
  const [draft, setDraft] = useState('')
  const pending = conversation.messages.some((m) => m.kind === 'permission' && m.state === 'pending')
  return (
    <section className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
          <MessageList
            messages={conversation.messages}
            thinking={conversation.thinking}
            onOpen={onOpen}
            permission={(m) => <PermissionCard study={study} m={m} />}
          />
          {conversation.reflection && (
            <div className="mt-2 rounded-xl border border-dashed border-border p-3">
              <div className="mb-1 text-micro text-muted-foreground">振り返り（会話の終わりに Tutor が書いた）</div>
              <Prose text={conversation.reflection} />
            </div>
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-4">
        {conversation.endedAt ? (
          <p className="py-3 text-center text-caption text-muted-foreground">この会話は終わっている。読めるが、続けられない。</p>
        ) : (
          <>
            {pending && <p className="pb-1.5 text-caption text-muted-foreground">許可に答えるまで、Tutor は止まっている。</p>}
            <InputMessage
              value={draft}
              onValueChange={setDraft}
              disabled={pending}
              onSend={(t) => {
                actions.send(study.id, t)
                setDraft('')
              }}
              placeholder="Tutor に話す"
              sendLabel="送る"
            />
          </>
        )}
      </div>
    </section>
  )
}

export function MoreMenu({ study, after }: { study: Study; after: string }) {
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  return (
    <div className="relative">
      <Button size="icon-sm" variant="ghost" aria-label="その他" onClick={() => setMenu((m) => !m)}>
        <MoreHorizontal />
      </Button>
      {menu && (
        <div className="absolute top-full right-0 z-30 mt-1 w-40 rounded-xl bg-surface-4 p-1 shadow-surface-4">
          <button
            type="button"
            onClick={() => {
              setMenu(false)
              setConfirming(true)
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-caption text-destructive hover:bg-hover"
          >
            <Trash2 className="size-3.5" />
            Study を消す
          </button>
        </div>
      )}
      {confirming && (
        <Dialog onClose={() => setConfirming(false)}>
          <h2 className="mb-2 text-title font-semibold">Study を消す</h2>
          <p className="mb-2 text-body">次のものを取り消せない形で消す。Learning Preference は残る。</p>
          <ul className="mb-3 list-disc pl-5 text-caption text-muted-foreground">
            {DELETED_THINGS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="mb-1.5 text-caption">
            確かめるため <code>{study.short}</code> と打つ
          </p>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="mb-4 w-full rounded-lg bg-muted px-2 py-1.5 font-mono text-body outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="compact" onClick={() => setConfirming(false)}>
              やめる
            </Button>
            <Button
              variant="primary"
              size="compact"
              disabled={typed !== study.short}
              className="bg-destructive!"
              onClick={() => {
                actions.remove(study.id)
                go(after)
              }}
            >
              消す
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

export function ScreenA({ study }: { study: Study }) {
  const active = activeConversation(study)
  const [selected, setSelected] = useState<string>(active?.id ?? study.conversations.at(-1)!.id)
  const [path, setPath] = useState('MISSION.md')
  const conversation = study.conversations.find((c) => c.id === selected) ?? study.conversations.at(-1)!

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr]">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Button size="icon-sm" variant="ghost" aria-label="Study の一覧" onClick={() => go(studyHref('/studies', 'A'))}>
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-title font-semibold">{missionLine(study)}</span>
          <div className="flex items-center gap-3">
            <span className="rounded-md bg-muted px-1.5 text-micro text-muted-foreground">Tutor: repository</span>
            <LinkedRepos study={study} compact />
          </div>
        </div>
        <div className="w-80">
          <ShellCommand study={study} />
        </div>
        <MoreMenu study={study} after={studyHref('/studies', 'A')} />
      </header>

      <div className="grid min-h-0 grid-cols-[13rem_1fr_26rem]">
        <nav className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-border p-2">
          <Button
            size="compact"
            variant="secondary"
            leadingIcon={Plus}
            onClick={() => {
              actions.newConversation(study.id)
              setSelected(`c${study.conversations.length + 1}`)
            }}
          >
            新しい会話
          </Button>
          {[...study.conversations].reverse().map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.id)}
              className={`flex flex-col rounded-lg px-2.5 py-2 text-left ${c.id === conversation.id ? 'bg-selected' : 'hover:bg-hover'}`}
            >
              <span className="text-caption font-medium">
                会話 {c.n}
                {!c.endedAt && <span className="ml-1.5 text-micro text-[var(--success)]">● 続いている</span>}
              </span>
              <span className="text-micro text-muted-foreground">
                {c.startedAt}
                {c.endedAt ? `〜${c.endedAt.split(' ')[1]}（${c.endedBy}で終わり）` : ''}
              </span>
            </button>
          ))}
        </nav>

        <ChatColumn study={study} conversation={conversation} onOpen={setPath} />

        <ArtifactPane study={study} path={path} onOpen={setPath} />
      </div>
    </div>
  )
}
