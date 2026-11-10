// PROTOTYPE（Study の画面の試作、捨てる）: 案 C「1 本の流れ」。
// 名前は Mission の 1 行目。終わりの状態は持たず、触らない Study は一覧で自然に沈む（Playground が消えたら印）。
// 会話を 1 列で読み、成果物は右から出す引き出し。会話の切り替えは上の選択。許可は入力欄と入れ替わる。
import { ArrowLeft, ChevronDown, Info, Library, Plus, ShieldAlert, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../../../../packages/chat/src/ui/fluid/button.tsx'
import { InputMessage } from '../../../../packages/chat/src/ui/fluid/input-message.tsx'
import { actions, activeConversation, type Conversation, type Message, missionLine, type Study, useStudies } from './data.ts'
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
  type VariantKey,
} from './parts.tsx'

export const BUCKETS = ['今日', 'この 1 週間', 'それより前', 'しばらく触っていない']

export function bucket(s: Study): string {
  if (s.lastActivity >= '2026-11-10') return '今日'
  if (s.lastActivity >= '2026-11-03') return 'この 1 週間'
  if (s.lastActivity >= '2026-08-10') return 'それより前'
  return 'しばらく触っていない'
}

export function ListC({ variant = 'C' }: { variant?: VariantKey }) {
  const [mission, setMission] = useState('')
  return (
    <div className="mx-auto w-full max-w-2xl px-6 pt-20 pb-24">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (mission.trim()) go(studyHref(`/studies/${actions.start(mission.trim())}`, variant))
        }}
        className="mb-12"
      >
        <input
          autoFocus
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          placeholder="何を学ぶ？"
          className="w-full rounded-2xl bg-surface-3 px-5 py-4 text-title shadow-surface-4 outline-none"
        />
      </form>
      <RecencyList variant={variant} />
    </div>
  )
}

export function RecencyList({ variant }: { variant: VariantKey }) {
  const studies = [...useStudies()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return (
    <>
      {BUCKETS.map((g) => {
        const items = studies.filter((s) => bucket(s) === g)
        if (items.length === 0) return null
        const sunk = g === 'しばらく触っていない'
        return (
          <section key={g} className={`mb-8 ${sunk ? 'opacity-55' : ''}`}>
            <h2 className="mb-2 text-micro tracking-wide text-muted-foreground">{g}</h2>
            <div className="flex flex-col gap-1 border-l border-border pl-4">
              {items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => go(studyHref(`/studies/${s.short}`, variant))}
                  className="flex flex-col gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-hover"
                >
                  <span className="text-subtitle">{missionLine(s)}</span>
                  <span className="line-clamp-1 text-caption text-muted-foreground">
                    {s.lastActivityLabel}・{(s.artifacts['log.md'] ?? '').split('\n').filter((l) => l.startsWith('- ')).at(-1)?.slice(2).replace(/[`[\]]|\(.*?\)/g, '')}
                  </span>
                  <span className="flex gap-2 text-micro text-muted-foreground">
                    {s.linkedRepos.map((r) => (
                      <span key={r} className="font-mono">
                        {r}
                      </span>
                    ))}
                    {s.playground === '消えた' && <span>Playground は消えた</span>}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

export function PermissionPrompt({ study, m }: { study: Study; m: Extract<Message, { kind: 'permission' }> }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') actions.answer(study.id, m.id, true)
      if (e.key === '2') actions.answer(study.id, m.id, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [study.id, m.id])
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-surface-4 p-4 shadow-surface-5 ring-1 ring-[var(--warning)]">
      <div className="flex items-center gap-1.5 text-subtitle font-medium">
        <ShieldAlert className="size-4" />
        箱の外で走らせてよいか
      </div>
      <pre className="overflow-x-auto rounded-lg bg-background px-3 py-2 font-mono text-caption whitespace-pre-wrap">{m.command}</pre>
      <p className="text-caption text-muted-foreground">{m.reason}</p>
      <div className="flex flex-col gap-1">
        <button type="button" onClick={() => actions.answer(study.id, m.id, true)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body hover:bg-hover">
          <kbd className="rounded bg-muted px-1.5 font-mono text-micro">1</kbd>許す（この 1 回だけ）
        </button>
        <button type="button" onClick={() => actions.answer(study.id, m.id, false)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body hover:bg-hover">
          <kbd className="rounded bg-muted px-1.5 font-mono text-micro">2</kbd>断る
        </button>
      </div>
    </div>
  )
}

export function PermissionDone({ m }: { m: Extract<Message, { kind: 'permission' }> }) {
  if (m.state === 'pending') return null
  return (
    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
      <ShieldAlert className="size-3.5" />
      <span className="truncate font-mono">{m.command}</span>
      <span className="shrink-0">を{m.state === 'allowed' ? '許した' : '断った'}</span>
    </div>
  )
}

export function Drawer({ study, path, onOpen, onClose }: { study: Study; path: string; onOpen: (p: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-[34rem] flex-col bg-surface-5 shadow-surface-7">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <select value={path} onChange={(e) => onOpen(e.target.value)} className="rounded-md bg-muted px-2 py-1 text-caption outline-none">
          {artifactPaths(study).map((p) => (
            <option key={p} value={p}>
              {artifactLabel(p)}
            </option>
          ))}
        </select>
        <span className="ml-2 font-mono text-micro text-muted-foreground">{path}</span>
        <Button size="compact" variant="ghost" className="ml-auto">
          エディタで開く
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="閉じる" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <Prose text={study.artifacts[path] ?? '（無い）'} from={path} onOpen={onOpen} />
      </div>
    </div>
  )
}

export function ConversationPicker({ study, selected, onSelect }: { study: Study; selected: Conversation; onSelect: (id: string) => void }) {
  const [picker, setPicker] = useState(false)
  const conversation = selected
  const setSelected = onSelect
  return (
    <div className="relative">
      <button type="button" onClick={() => setPicker((p) => !p)} className="flex items-center gap-1 rounded-md px-2 py-1 text-caption text-muted-foreground hover:bg-hover">
        会話 {conversation.n}
        {conversation.endedAt ? '（終わり）' : '（続いている）'}
        <ChevronDown className="size-3" />
      </button>
      {picker && (
        <div className="absolute top-full left-0 z-30 mt-1 w-72 rounded-xl bg-surface-4 p-1 shadow-surface-4">
          {[...study.conversations].reverse().map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setSelected(c.id)
                setPicker(false)
              }}
              className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
            >
              <span className="text-caption">
                会話 {c.n}・{c.startedAt}
                {!c.endedAt && '（続いている）'}
              </span>
              {c.reflection && <span className="line-clamp-1 text-micro text-muted-foreground">{c.reflection.replace(/`/g, '')}</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              actions.newConversation(study.id)
              setSelected(`c${study.conversations.length + 1}`)
              setPicker(false)
            }}
            className="mt-1 flex w-full items-center gap-1.5 rounded-lg border-t border-border px-2.5 py-1.5 text-caption hover:bg-hover"
          >
            <Plus className="size-3.5" />
            新しい会話を始める（今の会話は終わる）
          </button>
        </div>
      )}
    </div>
  )
}

export function ScreenC({ study }: { study: Study }) {
  const active = activeConversation(study)
  const [selected, setSelected] = useState(active?.id ?? study.conversations.at(-1)!.id)
  const [info, setInfo] = useState(false)
  const [drawer, setDrawer] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const conversation = study.conversations.find((c) => c.id === selected) ?? study.conversations.at(-1)!
  const pending = conversation.messages.find((m): m is Extract<Message, { kind: 'permission' }> => m.kind === 'permission' && m.state === 'pending')

  return (
    <div className="flex h-dvh flex-col">
      <header className="relative flex items-center gap-2 px-4 py-2.5">
        <Button size="icon-sm" variant="ghost" aria-label="Study の一覧" onClick={() => go(studyHref('/studies', 'C'))}>
          <ArrowLeft />
        </Button>
        <span className="min-w-0 truncate text-subtitle font-medium">{missionLine(study)}</span>
        <ConversationPicker study={study} selected={conversation} onSelect={setSelected} />
        <div className="ml-auto flex items-center gap-1">
          <Button size="compact" variant="ghost" leadingIcon={Library} onClick={() => setDrawer(drawer ? null : 'MISSION.md')}>
            成果物
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Study の情報" active={info} onClick={() => setInfo((i) => !i)}>
            <Info />
          </Button>
        </div>
        {info && (
          <div className="absolute top-full right-4 z-30 flex w-96 flex-col gap-3 rounded-2xl bg-surface-4 p-4 shadow-surface-5">
            <div className="flex flex-col gap-1">
              <span className="text-micro text-muted-foreground">紐付けた Repo</span>
              <LinkedRepos study={study} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-micro text-muted-foreground">Playground に入る</span>
              <ShellCommand study={study} />
            </div>
            <div className="text-micro text-muted-foreground">Tutor: repository（会話の中で替わることがある）</div>
            <button type="button" onClick={() => setConfirming(true)} className="flex items-center gap-1.5 self-start text-caption text-destructive">
              <Trash2 className="size-3.5" />
              Study を消す
            </button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
          {conversation.endedAt && (
            <div className="rounded-lg bg-muted px-3 py-2 text-caption text-muted-foreground">
              会話 {conversation.n} は {conversation.endedAt} に終わった（{conversation.endedBy}）。読めるが、続けられない。
            </div>
          )}
          <MessageList
            messages={conversation.messages}
            thinking={conversation.thinking}
            onOpen={setDrawer}
            permission={(m) => <PermissionDone m={m} />}
          />
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
          active ? (
            <Button variant="secondary" className="w-full" onClick={() => setSelected(active.id)}>
              続いている会話 {active.n} に戻る
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="w-full"
              leadingIcon={Plus}
              onClick={() => {
                actions.newConversation(study.id)
                setSelected(`c${study.conversations.length + 1}`)
              }}
            >
              新しい会話を始める
            </Button>
          )
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

      {drawer && <Drawer study={study} path={drawer} onOpen={setDrawer} onClose={() => setDrawer(null)} />}

      {confirming && (
        <Dialog onClose={() => setConfirming(false)}>
          <h2 className="mb-2 text-title font-semibold">「{missionLine(study)}」を消す</h2>
          <ul className="mb-3 list-disc pl-5 text-caption text-muted-foreground">
            {DELETED_THINGS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <label className="mb-4 flex items-center gap-2 text-caption">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            取り消せないことを分かった（Learning Preference は残る）
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="compact" onClick={() => setConfirming(false)}>
              やめる
            </Button>
            <Button
              variant="primary"
              size="compact"
              disabled={!understood}
              className="bg-destructive!"
              onClick={() => {
                actions.remove(study.id)
                go(studyHref('/studies', 'C'))
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
