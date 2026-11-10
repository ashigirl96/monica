// PROTOTYPE（Study の画面の試作、捨てる）: 3 案が共有する小さな部品と、案の切り替え。
import { Check, ChevronLeft, ChevronRight, Copy, FileText, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ChatMessage } from '../../../../packages/chat/src/ui/fluid/chat-message.tsx'
import { ThinkingIndicator } from '../../../../packages/chat/src/ui/fluid/thinking-indicator.tsx'
import { actions, type Message, REPO_CANDIDATES, type Study } from './data.ts'

export function go(to: string) {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb)
  return () => window.removeEventListener('popstate', cb)
}

export const VARIANTS = [
  { key: 'A', name: '会話が真ん中' },
  { key: 'B', name: '成果物が本、会話は脇' },
  { key: 'C', name: '1 本の流れ' },
  { key: 'D', name: '組み合わせ：左に木、右に中身' },
  { key: 'E', name: 'Study は左、成果物は右' },
  { key: 'F', name: '表紙と会話' },
] as const
export type VariantKey = (typeof VARIANTS)[number]['key']

export function variantOf(search: string): VariantKey {
  const v = new URLSearchParams(search).get('variant')
  return VARIANTS.some((x) => x.key === v) ? (v as VariantKey) : 'A'
}

export function useVariant(): VariantKey {
  return variantOf(useSyncExternalStore(subscribe, () => window.location.search))
}

/** ⌥N で新しい会話（新しい Study）の画面に移る。⌘N は Chrome の tab では page に届かないので、note の「作る」と同じ ⌥N にする。 */
export function useNewStudyKey(variant: VariantKey) {
  useEffect(() => {
    if (!['D', 'E', 'F'].includes(variant)) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.code !== 'KeyN') return
      e.preventDefault()
      go(studyHref('/studies', variant))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [variant])
}

export function studyHref(path: string, variant: VariantKey): string {
  return `${path}?variant=${variant}`
}

function setVariant(key: VariantKey) {
  const url = new URL(window.location.href)
  url.searchParams.set('variant', key)
  window.history.replaceState(null, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function PrototypeSwitcher() {
  const current = useVariant()
  const index = VARIANTS.findIndex((v) => v.key === current)
  const step = (d: number) => setVariant(VARIANTS[(index + d + VARIANTS.length) % VARIANTS.length]!.key)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [contenteditable]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const v = VARIANTS[index]!
  return (
    <div className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#1f1d2b] px-1.5 py-1 text-[12px] text-white shadow-lg ring-1 ring-white/20">
      <button type="button" aria-label="前の案" onClick={() => step(-1)} className="rounded-full p-1 hover:bg-white/15">
        <ChevronLeft className="size-4" />
      </button>
      <span className="px-1 font-mono">
        試作 {v.key}（{v.name}）
      </span>
      <button type="button" aria-label="次の案" onClick={() => step(1)} className="rounded-full p-1 hover:bg-white/15">
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}

function resolve(from: string, href: string): string {
  return new URL(href, `file:///${from}`).pathname.slice(1)
}

/** 成果物と Tutor の文を、HTML を通さずに描く。相対 link は成果物の間の移動にする。 */
export function Prose({
  text,
  from = '',
  onOpen,
  className = '',
}: {
  text: string
  from?: string
  onOpen?: (path: string) => void
  className?: string
}) {
  return (
    <div className={`typeset ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>
            if (/^https?:/.test(href)) {
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              )
            }
            const path = resolve(from, href)
            return (
              <a
                href={`#${path}`}
                onClick={(e) => {
                  e.preventDefault()
                  onOpen?.(path)
                }}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

export function ToolLine({ text, path, onOpen }: { text: string; path?: string; onOpen?: (path: string) => void }) {
  const body = (
    <>
      <FileText className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </>
  )
  if (!path || !onOpen) {
    return <div className="flex items-center gap-1.5 text-caption text-muted-foreground">{body}</div>
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      className="flex items-center gap-1.5 self-start rounded-md px-1 text-caption text-muted-foreground hover:bg-hover hover:text-foreground"
    >
      {body}
    </button>
  )
}

export function ShellCommand({ study, by = 'short' }: { study: Study; by?: 'short' | 'title' }) {
  const text = by === 'title' ? `monica study shell "${study.title}"` : `monica study shell ${study.short}`
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate bg-transparent! p-0! font-mono text-caption">{text}</code>
      <button
        type="button"
        aria-label="写す"
        title="写す"
        onClick={() => {
          void navigator.clipboard?.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
        className="rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

/** 紐付けた Repo の足し外し。候補は Repo の一覧、無ければ owner/repo を手で打つ。 */
export function LinkedRepos({ study, compact = false }: { study: Study; compact?: boolean }) {
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const candidates = REPO_CANDIDATES.filter((r) => !study.linkedRepos.includes(r) && r.toLowerCase().includes(q.toLowerCase()))
  const typed = /^[\w.-]+\/[\w.-]+$/.test(q) && !REPO_CANDIDATES.includes(q) && !study.linkedRepos.includes(q)
  const add = (repo: string) => {
    actions.link(study.id, repo)
    setQ('')
    setAdding(false)
  }
  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      {study.linkedRepos.map((r) => (
        <span key={r} className="group flex items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2 font-mono text-caption">
          {r}
          <button
            type="button"
            aria-label={`${r} の紐付けを外す`}
            onClick={() => actions.unlink(study.id, r)}
            className="rounded p-0.5 text-muted-foreground opacity-40 group-hover:opacity-100 hover:bg-hover"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {study.linkedRepos.length === 0 && !compact && <span className="text-caption text-muted-foreground">紐付けた Repo は無い</span>}
      <button
        type="button"
        onClick={() => setAdding((a) => !a)}
        className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <Plus className="size-3" />
        Repo
      </button>
      {adding && (
        <div className="absolute top-full left-0 z-30 mt-1 w-72 rounded-xl bg-surface-4 p-1.5 shadow-surface-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAdding(false)
              if (e.key === 'Enter' && (typed || candidates[0])) add(typed ? q : candidates[0]!)
            }}
            placeholder="Repo を選ぶか owner/repo を打つ"
            className="w-full rounded-lg bg-muted px-2 py-1.5 font-mono text-caption outline-none"
          />
          <div className="mt-1 flex flex-col">
            {candidates.map((r) => (
              <button key={r} type="button" onClick={() => add(r)} className="rounded-md px-2 py-1 text-left font-mono text-caption hover:bg-hover">
                {r}
              </button>
            ))}
            {typed && (
              <button type="button" onClick={() => add(q)} className="rounded-md px-2 py-1 text-left text-caption hover:bg-hover">
                <span className="font-mono">{q}</span> を紐付ける（Repo の一覧に無い）
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function Dialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div className="w-[26rem] rounded-2xl bg-surface-6 p-5 shadow-surface-6" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

export const ARTIFACT_LABELS: Record<string, string> = {
  'MISSION.md': 'Mission',
  'RESOURCES.md': '一次資料',
  'GLOSSARY.md': '用語集',
  'log.md': '経過の記録',
}

export function artifactLabel(path: string): string {
  return ARTIFACT_LABELS[path] ?? path.replace(/^learning-records\//, '学習記録 ').replace(/\.md$/, '')
}

export function artifactPaths(study: Study): string[] {
  const keys = Object.keys(study.artifacts)
  const fixed = ['MISSION.md', 'RESOURCES.md', 'learning-records', 'GLOSSARY.md', 'log.md']
  return keys.sort((a, b) => fixed.findIndex((f) => a.startsWith(f)) - fixed.findIndex((f) => b.startsWith(f)) || a.localeCompare(b))
}

export const DELETED_THINGS = [
  '成果物（Mission・一次資料・学習記録・用語集・経過の記録）',
  'Prototype',
  'Playground（env/・印の付いた docker の物・この Study だけの nix の path）',
  '会話の記録と、Repo との紐付け',
]

export function MessageList({
  messages,
  thinking,
  onOpen,
  permission,
  tutorLabel = false,
}: {
  messages: Message[]
  thinking?: boolean
  onOpen?: (path: string) => void
  permission: (m: Extract<Message, { kind: 'permission' }>) => ReactNode
  tutorLabel?: boolean
}) {
  return (
    <>
      {messages.map((m, i) => {
        switch (m.kind) {
          case 'user':
            return (
              <ChatMessage key={i} from="user" className="max-w-[85%]">
                {m.text}
              </ChatMessage>
            )
          case 'tutor':
            return (
              <div key={i} className="flex flex-col gap-1">
                {tutorLabel && <span className="text-micro text-muted-foreground">Tutor: {m.tutor}</span>}
                <ChatMessage from="assistant" className="w-full max-w-full items-stretch">
                  <Prose text={m.text} />
                </ChatMessage>
              </div>
            )
          case 'tool':
            return <ToolLine key={i} text={m.text} path={m.path} onOpen={onOpen} />
          case 'tutor-switch':
            return (
              <div key={i} className="text-center text-micro text-muted-foreground">
                Tutor を {m.tutor} に替えた
              </div>
            )
          case 'permission':
            return <div key={i}>{permission(m)}</div>
        }
      })}
      {thinking && <ThinkingIndicator className="px-0" />}
    </>
  )
}
