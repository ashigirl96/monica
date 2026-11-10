import { Toaster } from '@monica/ui'
import type { MouseEvent, ReactNode } from 'react'
import { createContext, useContext, useEffect } from 'react'

import type { StudyClient } from './client.ts'
import { listenNewConversationKey } from './new-conversation-key.ts'

export type Navigation = {
  navigate: (to: string) => void
  spaLinkClick: (to: string) => (e: MouseEvent) => void
}

export type ScreenDeps = Navigation & { client: StudyClient }

export const ScreenContext = createContext<ScreenDeps | null>(null)

export function useScreen(): ScreenDeps {
  const deps = useContext(ScreenContext)
  if (deps === null) throw new Error('useScreen requires the slot page of study')
  return deps
}

const APP_NAME = 'monica'

export function useDocumentTitle(name: string | null): void {
  useEffect(() => {
    document.title = name === null ? APP_NAME : `${name} · ${APP_NAME}`
  }, [name])
}

export function useNewConversationKey(onPress: () => void): void {
  useEffect(() => listenNewConversationKey(onPress), [onPress])
}

/** note の ⌘+ は --note-zoom を変えるだけなので、自分で当てないとキーが何も変えない。 */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="fluid flex h-[calc(100dvh/var(--note-zoom,1))] [zoom:var(--note-zoom,1)] flex-col bg-background text-foreground">
      {children}
      {/* web の組み立ては Toaster を置かないので、Study の画面が自分で置く。 */}
      <Toaster />
    </div>
  )
}

export type StudyNamed = { missionLine: string | null; firstMessage: string | null }

export function nameOf(study: StudyNamed): { text: string; faint: boolean } {
  if (study.missionLine !== null) return { text: study.missionLine, faint: false }
  if (study.firstMessage !== null) return { text: study.firstMessage, faint: true }
  return { text: '（まだ何も話していない）', faint: true }
}

export function StudyName({ study, className }: { study: StudyNamed; className?: string }) {
  const { text, faint } = nameOf(study)
  return (
    <span className={`truncate ${faint ? 'text-muted-foreground' : ''} ${className ?? ''}`}>
      {text}
    </span>
  )
}

export function FailureLine({ children }: { children: string | null }) {
  if (children === null) return null
  return (
    <p role="alert" className="truncate px-1 text-[13px] text-destructive">
      {children}
    </p>
  )
}
