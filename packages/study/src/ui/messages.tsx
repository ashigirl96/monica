import { ChatMessage } from '@monica/ui/fluid'
import { type Components, Markdown } from '@monica/ui/markdown'
import { FileText, PenLine, Search, ShieldAlert, SquareTerminal, Wrench } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'

import type { StudyMessage } from '../contract.ts'
import { writtenArtifact } from './artifact-link.ts'

// 既定の a のままだと、相対 link が /studies/ の下の URL に移って画面が壊れる。
const tutorComponents: Components = {
  a: ({ href, children }) =>
    href !== undefined && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
}

export function TutorText({ text }: { text: string }) {
  return (
    <ChatMessage from="assistant">
      <Markdown text={text} components={tutorComponents} />
    </ChatMessage>
  )
}

function within(target: string, dir: string): string {
  return target.startsWith(`${dir}/`) ? target.slice(dir.length + 1) : target
}

const TOOL_LINES: Record<string, { icon: typeof FileText; line: (t: string) => ReactNode }> = {
  Read: { icon: FileText, line: (t) => `${t} を読んだ` },
  WebFetch: { icon: FileText, line: (t) => `${t} を読んだ` },
  Write: { icon: PenLine, line: (t) => `${t} を書いた` },
  Edit: { icon: PenLine, line: (t) => `${t} を書いた` },
  Bash: {
    icon: SquareTerminal,
    line: (t) => (
      <>
        <code>{t}</code> を走らせた
      </>
    ),
  },
  WebSearch: { icon: Search, line: (t) => `${t} を探した` },
  Glob: { icon: Search, line: (t) => `${t} を探した` },
  Grep: { icon: Search, line: (t) => `${t} を探した` },
}

function ToolLine({
  message,
  dir,
  onOpenArtifact,
}: {
  message: StudyMessage
  dir: string
  onOpenArtifact?: ((path: string) => void) | undefined
}) {
  const tool = message.tool ?? ''
  const known = TOOL_LINES[tool]
  const Icon = known?.icon ?? Wrench
  const line = (
    <>
      <Icon className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 truncate">
        {known ? known.line(within(message.text, dir)) : `${tool} を使った`}
      </span>
    </>
  )
  const written = writtenArtifact(message, dir)
  if (written !== null && onOpenArtifact) {
    return (
      <button
        type="button"
        onClick={() => onOpenArtifact(written)}
        className="flex items-center gap-2 text-left text-[13px] text-muted-foreground hover:text-foreground"
      >
        {line}
      </button>
    )
  }
  return <p className="flex items-center gap-2 text-[13px] text-muted-foreground">{line}</p>
}

export function MessageView({
  message,
  dir,
  onOpenArtifact,
}: {
  message: StudyMessage
  dir: string
  onOpenArtifact?: (path: string) => void
}) {
  switch (message.kind) {
    case 'user':
      return <ChatMessage from="user">{message.text}</ChatMessage>
    case 'tutor':
      return <TutorText text={message.text} />
    case 'tool':
      return <ToolLine message={message} dir={dir} onOpenArtifact={onOpenArtifact} />
    case 'tutor_switch':
      return (
        <p className="text-center text-[13px] text-muted-foreground">
          Tutor を {message.text} に替えた
        </p>
      )
    case 'permission':
      return (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <ShieldAlert className="size-3.5 shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 truncate">
            <code>{message.text.split('\n')[0]}</code> を
            {message.state === 'allowed' ? '許した' : '断った'}
          </span>
        </p>
      )
  }
}

export type KeyboardEventLike = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'
>

/** 1 は許す、2 は断る。修飾キー付きと変換中は答えにしない。 */
export function permissionAnswerOf(event: KeyboardEventLike): boolean | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) {
    return null
  }
  return event.key === '1' ? true : event.key === '2' ? false : null
}

export function PermissionPrompt({
  permission,
  onAnswer,
}: {
  permission: StudyMessage
  onAnswer: (allow: boolean) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => panel.current?.focus(), [])
  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label="箱の外で走らせてよいか"
      onKeyDown={(event) => {
        const allow = permissionAnswerOf({ ...event, isComposing: event.nativeEvent.isComposing })
        if (allow === null) return
        event.preventDefault()
        onAnswer(allow)
      }}
      className="flex flex-col gap-2.5 rounded-2xl border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="flex items-center gap-1.5 text-[15px] font-medium">
        <ShieldAlert className="size-4" strokeWidth={1.8} />
        箱の外で走らせてよいか
      </p>
      <pre className="rounded-lg bg-muted px-3 py-2 font-mono text-[13px] break-all whitespace-pre-wrap">
        {permission.text}
      </pre>
      <p className="text-[13px] text-muted-foreground">
        {permission.reason ?? '理由は書かれていない'}
      </p>
      <div className="flex flex-col gap-1">
        <AnswerButton digit="1" onClick={() => onAnswer(true)}>
          許す（この 1 回だけ）
        </AnswerButton>
        <AnswerButton digit="2" onClick={() => onAnswer(false)}>
          断る
        </AnswerButton>
      </div>
    </div>
  )
}

function AnswerButton({
  digit,
  onClick,
  children,
}: {
  digit: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
    >
      <kbd className="rounded bg-muted px-1.5 font-mono text-[12px]">{digit}</kbd>
      {children}
    </button>
  )
}

export function currentTutor(messages: readonly StudyMessage[]): string {
  return messages.findLast((message) => message.kind === 'tutor_switch')?.text ?? '共通の教え方'
}
