// PROTOTYPE（Study の画面の試作、捨てる）: 案 B「成果物が本、会話は脇」。
// Study は自分の題を持つ。終わりの状態「脇へ寄せる」があり、消せるのは寄せた Study だけ。
// 成果物を真ん中で読み、会話は右の欄に 1 本の流れで続ける（前の会話は区切り線で畳む）。許可は入力欄の上に留める。
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, ExternalLink, FileText, Folder, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../../../../packages/chat/src/ui/fluid/button.tsx'
import { InputMessage } from '../../../../packages/chat/src/ui/fluid/input-message.tsx'
import { actions, activeConversation, type Conversation, type Message, missionBody, pendingPermission, type Study, useStudies } from './data.ts'
import { artifactLabel, artifactPaths, Dialog, go, LinkedRepos, MessageList, Prose, ShellCommand, studyHref } from './parts.tsx'

function lastLogLine(s: Study): string {
  return (s.artifacts['log.md'] ?? '').split('\n').filter((l) => l.startsWith('- ')).at(-1)?.slice(2) ?? ''
}

function StudyCard({ s }: { s: Study }) {
  return (
    <button
      type="button"
      onClick={() => go(studyHref(`/studies/${s.short}`, 'B'))}
      className="flex flex-col gap-2 rounded-2xl bg-surface-3 p-4 text-left shadow-surface-3 transition-shadow hover:shadow-surface-5"
    >
      <div className="flex items-center gap-2">
        <span className="text-title font-semibold">{s.title}</span>
        {pendingPermission(s) && <ShieldAlert className="size-3.5 text-[var(--warning)]" />}
        <span className="ml-auto text-micro text-muted-foreground">{s.lastActivityLabel}</span>
      </div>
      <Prose text={missionBody(s)} className="line-clamp-3 text-body text-muted-foreground" />
      <p className="line-clamp-1 border-t border-border pt-2 text-caption">
        <span className="text-muted-foreground">最後の記録: </span>
        <Prose text={lastLogLine(s)} className="inline [&_p]:inline" />
      </p>
      {s.linkedRepos.length > 0 && <span className="font-mono text-micro text-muted-foreground">{s.linkedRepos.join('  ')}</span>}
    </button>
  )
}

export function ListB() {
  const studies = [...useStudies()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  const [showArchived, setShowArchived] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mission, setMission] = useState('')
  const archived = studies.filter((s) => s.archived)
  return (
    <div className="mx-auto w-full max-w-5xl px-8 pt-16 pb-24">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-display font-semibold">Study</h1>
        <Button variant="primary" leadingIcon={Plus} onClick={() => setStarting(true)}>
          新しい Study
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {studies.filter((s) => !s.archived).map((s) => (
          <StudyCard key={s.id} s={s} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => setShowArchived((v) => !v)}
        className="mt-10 flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
      >
        {showArchived ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        脇へ寄せた Study（{archived.length}）
      </button>
      {showArchived && (
        <div className="mt-3 flex flex-col">
          {archived.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => go(studyHref(`/studies/${s.short}`, 'B'))}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-hover"
            >
              <Archive className="size-3.5 text-muted-foreground" />
              <span className="text-body">{s.title}</span>
              <span className="text-caption text-muted-foreground">Playground は{s.playground}</span>
              <span className="ml-auto text-caption text-muted-foreground">{s.lastActivityLabel}</span>
            </button>
          ))}
        </div>
      )}
      {starting && (
        <Dialog onClose={() => setStarting(false)}>
          <h2 className="mb-3 text-title font-semibold">新しい Study</h2>
          <textarea
            autoFocus
            value={mission}
            onChange={(e) => setMission(e.target.value)}
            placeholder="何を学びたいか。題と Mission は Tutor と決める。"
            className="mb-4 h-24 w-full resize-none rounded-lg bg-muted px-2.5 py-2 text-body outline-none"
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="compact"
              disabled={!mission.trim()}
              onClick={() => go(studyHref(`/studies/${actions.start(mission.trim())}`, 'B'))}
            >
              始める
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function Divider({ c, open, onToggle }: { c: Conversation; open: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={onToggle} className="flex items-center gap-2 text-micro text-muted-foreground hover:text-foreground">
        <span className="h-px flex-1 bg-border" />
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        会話 {c.n}・{c.startedAt}・{c.endedBy}で終わり
        <span className="h-px flex-1 bg-border" />
      </button>
      {c.reflection && (
        <div className="rounded-lg bg-muted px-3 py-2 text-caption">
          <span className="text-muted-foreground">振り返り: </span>
          <Prose text={c.reflection} className="inline [&_p]:inline" />
        </div>
      )}
    </div>
  )
}

function Conversations({ study, onOpen }: { study: Study; onOpen: (p: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState('')
  const active = activeConversation(study)
  const pending = pendingPermission(study)

  return (
    <aside className="flex min-h-0 flex-col border-l border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-subtitle font-medium">会話</span>
        <Button size="compact" variant="ghost" leadingIcon={Plus} disabled={study.archived} onClick={() => actions.newConversation(study.id)}>
          新しい会話
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div className="flex flex-col gap-4 px-3 py-4">
          {study.conversations.map((c) =>
            c.endedAt ? (
              <div key={c.id} className="flex flex-col gap-3">
                <Divider c={c} open={!!open[c.id]} onToggle={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))} />
                {open[c.id] && (
                  <div className="flex flex-col gap-3 opacity-70">
                    <MessageList messages={c.messages} onOpen={onOpen} tutorLabel permission={(m) => <PermissionLine m={m} />} />
                  </div>
                )}
              </div>
            ) : (
              <div key={c.id} className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-micro text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  会話 {c.n}・{c.startedAt}〜
                  <span className="h-px flex-1 bg-border" />
                </div>
                <MessageList
                  messages={c.messages}
                  thinking={c.thinking}
                  onOpen={onOpen}
                  tutorLabel
                  permission={(m) => <PermissionLine m={m} />}
                />
              </div>
            ),
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {pending && (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-4 p-3 shadow-surface-4 ring-1 ring-[var(--warning)]">
            <div className="flex items-center gap-1.5 text-caption font-medium">
              <ShieldAlert className="size-3.5" />
              Tutor が箱の外で走らせたい
            </div>
            <code className="block overflow-x-auto rounded-md bg-background! px-2 py-1.5 font-mono text-micro whitespace-pre-wrap">{pending.command}</code>
            <p className="text-micro text-muted-foreground">{pending.reason}</p>
            <div className="flex gap-2">
              <Button size="compact" variant="primary" onClick={() => actions.answer(study.id, pending.id, true)}>
                許す
              </Button>
              <Button size="compact" variant="secondary" onClick={() => actions.answer(study.id, pending.id, false)}>
                断る
              </Button>
            </div>
          </div>
        )}
        {study.archived ? (
          <p className="py-2 text-center text-caption text-muted-foreground">脇へ寄せた Study。戻すと会話を始められる。</p>
        ) : active ? (
          <InputMessage
            value={draft}
            onValueChange={setDraft}
            disabled={!!pending}
            onSend={(t) => {
              actions.send(study.id, t)
              setDraft('')
            }}
            placeholder={pending ? '許可に答えると続く' : 'Tutor に話す'}
            sendLabel="送る"
          />
        ) : null}
      </div>
    </aside>
  )
}

function PermissionLine({ m }: { m: Extract<Message, { kind: 'permission' }> }) {
  return (
    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
      <ShieldAlert className="size-3.5" />
      <span className="truncate font-mono">{m.command.split(' ').slice(0, 2).join(' ')}</span>
      <span>の許可を{m.state === 'pending' ? '求めている（下の欄）' : m.state === 'allowed' ? '許した' : '断った'}</span>
    </div>
  )
}

function Index({ study, path, onOpen }: { study: Study; path: string; onOpen: (p: string) => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  const paths = artifactPaths(study)
  const top = paths.filter((p) => !p.includes('/'))
  const records = paths.filter((p) => p.startsWith('learning-records/'))
  const item = (p: string, label: string) => (
    <button
      key={p}
      type="button"
      onClick={() => onOpen(p)}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-caption ${p === path ? 'bg-selected' : 'text-muted-foreground hover:bg-hover'}`}
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
  return (
    <nav className="flex min-h-0 flex-col overflow-y-auto border-r border-border p-3">
      <button type="button" onClick={() => go(studyHref('/studies', 'B'))} className="mb-3 self-start text-micro text-muted-foreground hover:text-foreground">
        ← Study の一覧
      </button>
      <span className="mb-3 text-title font-semibold">{study.title}</span>
      <div className="flex flex-col gap-0.5">
        {top.slice(0, 2).map((p) => item(p, artifactLabel(p)))}
        <span className="mt-1 flex items-center gap-1.5 px-2 py-1 text-caption text-muted-foreground">
          <Folder className="size-3.5" />
          学習記録
        </span>
        <div className="flex flex-col gap-0.5 pl-3">{records.map((p) => item(p, p.slice(17, 21) + ' ' + (study.artifacts[p]?.split('\n')[0]?.replace(/^# \d+ /, '') ?? '')))}</div>
        {top.slice(2).map((p) => item(p, artifactLabel(p)))}
      </div>

      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-micro text-muted-foreground">紐付けた Repo</span>
          <LinkedRepos study={study} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-micro text-muted-foreground">Playground に入る（{study.playground === 'ある' ? 'ある' : '消えた。入ると作り直す'}）</span>
          <ShellCommand study={study} by="title" />
        </div>
        <div className="flex gap-1.5">
          {study.archived ? (
            <>
              <Button size="compact" variant="secondary" leadingIcon={ArchiveRestore} onClick={() => actions.setArchived(study.id, false)}>
                戻す
              </Button>
              <Button
                size="compact"
                variant={armed ? 'primary' : 'ghost'}
                leadingIcon={Trash2}
                className={armed ? 'bg-destructive!' : 'text-destructive'}
                onClick={() => {
                  if (!armed) return setArmed(true)
                  actions.remove(study.id)
                  go(studyHref('/studies', 'B'))
                }}
              >
                {armed ? 'もう一度押すと取り消せずに消す' : '消す'}
              </Button>
            </>
          ) : (
            <Button size="compact" variant="secondary" leadingIcon={Archive} onClick={() => actions.setArchived(study.id, true)}>
              脇へ寄せる
            </Button>
          )}
        </div>
      </div>
    </nav>
  )
}

export function ScreenB({ study }: { study: Study }) {
  const [path, setPath] = useState('MISSION.md')
  return (
    <div className="grid h-dvh grid-cols-[15rem_1fr_24rem]">
      <Index study={study} path={path} onOpen={setPath} />
      <main className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between px-8 pt-4">
          <span className="font-mono text-micro text-muted-foreground">{path}</span>
          <Button size="compact" variant="ghost" leadingIcon={ExternalLink}>
            エディタで開く
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-6">
            <Prose text={study.artifacts[path] ?? '（無い）'} from={path} onOpen={setPath} className="text-[15px]" />
          </div>
        </div>
      </main>
      <Conversations study={study} onOpen={setPath} />
    </div>
  )
}
