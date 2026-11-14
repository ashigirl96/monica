import { useResizableWidth } from '@monica/ui'
import { type CSSProperties, type ReactNode, useSyncExternalStore } from 'react'

/** note の AppShell の w-12。 */
const RAIL_W = 48
/** 会話の列に必ず残す幅。 */
const CHAT_MIN = 320
const TREE = { storageKey: 'monica-study-tree-w', initial: 240, min: 180, max: 480 }
const PANEL = { storageKey: 'monica-study-panel-w', initial: 448, min: 320, max: 960 }

const noteZoom = () => Number(document.documentElement.style.getPropertyValue('--note-zoom')) || 1

// ⌘+ は :root の --note-zoom を書き換えるだけで resize も起きないので、style の変化を見る。
function subscribeNoteZoom(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}

/** Screen が Study の画面ごと --note-zoom で拡大するので、欄の幅もその内側の px で数える。 */
function useNoteZoom(): number {
  return useSyncExternalStore(subscribeNoteZoom, noteZoom, () => 1)
}

export type Pane = ReturnType<typeof useResizableWidth>

/**
 * 左右の欄の幅。互いの幅を見合うと揺れ続けるので、左を先に決め、右には会話の最小幅を残した
 * 残りだけを渡す。
 */
export function useStudyPanes(panelOpen: boolean): { tree: Pane; panel: Pane } {
  const zoom = useNoteZoom()
  const tree = useResizableWidth({
    ...TREE,
    reserved: RAIL_W + CHAT_MIN + (panelOpen ? PANEL.min : 0),
    scale: zoom,
  })
  // shortcut: ⌥B で左を畳んでも左の幅を残したまま数える。畳んだ分も右に渡したくなったら zen を hook に渡す。
  const panel = useResizableWidth({
    ...PANEL,
    reserved: RAIL_W + CHAT_MIN + tree.width,
    grows: 'left',
    scale: zoom,
  })
  return { tree, panel }
}

/**
 * 幅をドラッグで変えられる Study の左右の欄。左の欄は、note の AppShell の ⌥B（zen）で
 * rail と一緒に畳む。
 */
export function SidePane({
  side,
  label,
  pane: { width: px, resizing, separatorProps },
  className,
  children,
}: {
  side: 'left' | 'right'
  label: string
  pane: Pane
  className?: string
  children: ReactNode
}) {
  const left = side === 'left'
  return (
    <div className="relative flex shrink-0" style={{ '--pane-w': `${px}px` } as CSSProperties}>
      <aside
        aria-label={label}
        className={`w-[var(--pane-w)] overflow-hidden ${
          left
            ? 'border-r group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0'
            : 'border-l'
        } ${resizing ? '' : 'transition-[width] duration-200 motion-reduce:transition-none'}`}
      >
        {/* 開閉の間に中身が折り返さないよう、幅は内側で固定する */}
        <div className={`flex h-full w-[var(--pane-w)] flex-col ${className ?? ''}`}>
          {children}
        </div>
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        {...separatorProps}
        className={`group/resize absolute inset-y-0 z-20 flex w-3 cursor-col-resize justify-center ${
          left ? 'right-0 translate-x-1/2 group-data-[zen]/shell:hidden' : 'left-0 -translate-x-1/2'
        }`}
      >
        <span
          className={`h-full w-0.5 transition-colors duration-100 ${
            resizing
              ? 'bg-muted-foreground'
              : 'bg-transparent group-hover/resize:bg-muted-foreground'
          }`}
        />
      </div>
      {/* ドラッグの間、会話の文字を選ばず、カーソルを境界の形に保つ */}
      {resizing && <div className="fixed inset-0 z-30 cursor-col-resize" />}
    </div>
  )
}
