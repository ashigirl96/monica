import { useResizableWidth } from '@monica/ui'
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'

import { useNoteKeys } from '../components/use-note-keys.ts'

import './notes.css'

type NoteDensity = 'relaxed' | 'compact'

const DENSITY_KEY = 'monica-notes-density'

function readDensity(): NoteDensity {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'relaxed'
}

/** app rail（app-shell の w-12）。zen 中はサイドバーごと畳まれるので過大見積りは無害 */
const RAIL_W = 48
/** 本文側に必ず残す幅 */
const MAIN_MIN = 320

/**
 * Note の画面の枠。サイドバー幅のドラッグリサイズ
 * （localStorage 永続化・ダブルクリックで既定幅に戻す）と ⌥D の density トグルを持つ。
 */
export function NotesShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [density, setDensity] = useState<NoteDensity>(readDensity)
  const {
    width: sidebarWidth,
    resizing,
    separatorProps,
  } = useResizableWidth({
    storageKey: 'monica-notes-sidebar-w',
    initial: 400,
    min: 260,
    max: 720,
    reserved: RAIL_W + MAIN_MIN,
  })

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density)
  }, [density])

  useNoteKeys(null, {
    toggleDensity: () => setDensity((d) => (d === 'compact' ? 'relaxed' : 'compact')),
  })

  return (
    <div
      className={`notes-screen relative flex h-dvh shrink-0 overflow-hidden ${
        resizing ? 'cursor-col-resize select-none' : ''
      }`}
      style={{ '--sb-w': `${sidebarWidth}px` } as CSSProperties}
      data-density={density}
    >
      <aside
        className={`w-[var(--sb-w)] shrink-0 overflow-hidden border-r border-[var(--ink-border)] bg-[var(--desk)] group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0 ${
          resizing ? '' : 'transition-[width] duration-200 motion-reduce:transition-none'
        }`}
      >
        {/* 開閉アニメーション中に中身が折り返さないよう幅は内側で固定する */}
        <div className="flex h-full w-[var(--sb-w)] flex-col">{sidebar}</div>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        {...separatorProps}
        className="group/resize absolute inset-y-0 left-[var(--sb-w)] z-20 flex w-3 -translate-x-1/2 cursor-col-resize justify-center group-data-[zen]/shell:hidden"
      >
        <span
          className={`h-full w-0.5 transition-colors duration-100 ${
            resizing
              ? 'bg-[var(--ink-muted)]'
              : 'bg-transparent group-hover/resize:bg-[var(--ink-muted)]'
          }`}
        />
      </div>

      {children}
    </div>
  )
}
