import { ChatMessage } from '@monica/ui/fluid'
import { type Components, Markdown } from '@monica/ui/markdown'
import { FileText, PenLine, Search, SquareTerminal, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'

import type { StudyMessage } from '../contract.ts'

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

function ToolLine({ tool, text, dir }: { tool: string; text: string; dir: string }) {
  const known = TOOL_LINES[tool]
  const Icon = known?.icon ?? Wrench
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Icon className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 truncate">
        {known ? known.line(within(text, dir)) : `${tool} を使った`}
      </span>
    </p>
  )
}

export function MessageView({ message, dir }: { message: StudyMessage; dir: string }) {
  switch (message.kind) {
    case 'user':
      return <ChatMessage from="user">{message.text}</ChatMessage>
    case 'tutor':
      return <TutorText text={message.text} />
    case 'tool':
      return <ToolLine tool={message.tool ?? ''} text={message.text} dir={dir} />
    case 'tutor_switch':
      return (
        <p className="text-center text-[13px] text-muted-foreground">
          Tutor を {message.text} に替えた
        </p>
      )
  }
}

export function currentTutor(messages: readonly StudyMessage[]): string {
  return messages.findLast((message) => message.kind === 'tutor_switch')?.text ?? '共通の教え方'
}
