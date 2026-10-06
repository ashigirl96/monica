import { type ReactNode, useEffect } from 'react'

import { ctrlOnly } from '../keys.ts'
import { navigate, spaLinkClick } from '../router.ts'
import { DAILY_PATH, ESSAYS_PATH, REPOS_PATH } from '../routes.ts'

export type Section = 'daily' | 'essays' | 'repos'

/** ⌃1/⌃2/⌃3 の遷移先 */
const NAV_SHORTCUTS: Record<string, string> = {
  Digit1: DAILY_PATH,
  Digit2: ESSAYS_PATH,
  Digit3: REPOS_PATH,
}

/** tooltip の "(⌃1)" は上の表から導出する。手書きすると表と食い違っても誰も気づけない */
const SHORTCUT_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(NAV_SHORTCUTS).map(([code, to]) => [to, `⌃${code.replace('Digit', '')}`]),
)

function RailLink({
  to,
  label,
  active,
  children,
}: {
  to: string
  label: string
  active: boolean
  children: ReactNode
}) {
  const shortcut = SHORTCUT_LABELS[to]
  return (
    <a
      href={to}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-current={active ? 'page' : undefined}
      onClick={spaLinkClick(to)}
      className={`flex size-9 items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground'
      }`}
    >
      {children}
    </a>
  )
}

export function AppShell({ active, children }: { active: Section | null; children: ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || !ctrlOnly(e)) return
      const to = NAV_SHORTCUTS[e.code]
      if (to === undefined) return
      e.preventDefault()
      e.stopPropagation()
      navigate(to)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="flex min-h-dvh">
      <nav className="sticky top-0 z-20 flex h-dvh w-12 shrink-0 flex-col items-center gap-1.5 overflow-hidden border-r bg-background pt-3 pb-4">
        <RailLink to={DAILY_PATH} label="Daily" active={active === 'daily'}>
          <svg
            className="size-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <rect x="4" y="5" width="16" height="15.5" rx="2" />
            <path strokeLinecap="round" d="M8 3v4M16 3v4M4 9.5h16" />
            <circle cx="12" cy="15" r="1" fill="currentColor" stroke="none" />
          </svg>
        </RailLink>
        <RailLink to={ESSAYS_PATH} label="Essay" active={active === 'essays'}>
          <svg
            className="size-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <rect x="5" y="3.5" width="14" height="17" rx="2" />
            <path strokeLinecap="round" d="M8.5 8h7M8.5 11.5h7M8.5 15h4.5" />
          </svg>
        </RailLink>
        <RailLink to={REPOS_PATH} label="Repo" active={active === 'repos'}>
          <svg
            className="size-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.5 7.5a2 2 0 012-2h4l2 2.5h5a2 2 0 012 2v7a2 2 0 01-2 2h-11a2 2 0 01-2-2z"
            />
          </svg>
        </RailLink>
      </nav>
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
