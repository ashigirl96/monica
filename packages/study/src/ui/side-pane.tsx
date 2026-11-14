import { type ResizableWidth, useResizableWidth } from '@monica/ui'
import type { CSSProperties, ReactNode } from 'react'

/** note の AppShell の w-12。 */
const RAIL_W = 48
/** 会話の列に必ず残す幅。 */
const CHAT_MIN = 320

/**
 * 幅をドラッグで変えられる Study の左右の欄。左の欄は、note の AppShell の ⌥B（zen）で
 * rail と一緒に畳む。
 */
export function SidePane({
  side,
  label,
  width,
  className,
  children,
}: {
  side: 'left' | 'right'
  label: string
  width: Pick<ResizableWidth, 'storageKey' | 'initial' | 'min' | 'max'>
  className?: string
  children: ReactNode
}) {
  const {
    width: px,
    resizing,
    separatorProps,
  } = useResizableWidth({
    ...width,
    reserved: RAIL_W + CHAT_MIN,
    grows: side === 'left' ? 'right' : 'left',
  })
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
