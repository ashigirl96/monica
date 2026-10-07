import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from './cn.ts'

const ANCHOR_GAP = 4
const VIEWPORT_PADDING = 8
const MENU_SELECTOR = '[data-popover-menu]'

export type PopoverAnchor = { top: number; bottom: number; left: number }

export function PopoverMenu({
  anchor,
  onClose,
  className,
  children,
}: {
  anchor: PopoverAnchor
  onClose: () => void
  className?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // The anchor rect is captured at open time; measure the menu itself before
  // showing it so it can flip above the anchor near the bottom edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.min(
      Math.max(anchor.left, VIEWPORT_PADDING),
      window.innerWidth - width - VIEWPORT_PADDING,
    )
    let top = anchor.bottom + ANCHOR_GAP
    if (top + height > window.innerHeight - VIEWPORT_PADDING) {
      top = anchor.top - height - ANCHOR_GAP
    }
    setPos({ top: Math.max(top, VIEWPORT_PADDING), left })
  }, [anchor])

  // The menu does not track its anchor, so a scroll or resize closes it; a menu opened from
  // this one is portaled outside it, so a press or scroll in any open menu counts as inside.
  useEffect(() => {
    const outside = (e: Event) => !(e.target instanceof Element && e.target.closest(MENU_SELECTOR))
    const onEvent = (e: Event) => {
      if (outside(e)) onClose()
    }
    // Captured on window so the focused element (a terminal, say) never sees the Escape; every
    // open menu still does, since stopPropagation does not skip other listeners on the same target.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('scroll', onEvent, { capture: true })
    window.addEventListener('resize', onClose)
    window.addEventListener('pointerdown', onEvent)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('scroll', onEvent, { capture: true })
      window.removeEventListener('resize', onClose)
      window.removeEventListener('pointerdown', onEvent)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      data-popover-menu=""
      className={cn(
        'fixed z-50 w-44 rounded-md border border-border bg-popover p-1 shadow-lg',
        className,
      )}
      style={
        pos
          ? { top: pos.top, left: pos.left }
          : { top: anchor.bottom + ANCHOR_GAP, left: anchor.left, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
  )
}

export function PopoverMenuItem({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-popover-foreground',
        'hover:bg-accent hover:text-accent-foreground disabled:opacity-40',
        className,
      )}
      {...props}
    />
  )
}

export function PopoverMenuSeparator() {
  return <div className="my-1 h-px bg-border" />
}
