import { cn } from '@tania/ui'
import { useSetAtom } from 'jotai'
import { useCallback, useEffect, useRef } from 'react'

import { clamp } from './clamp.ts'
import {
  sidebarWidthAtom,
  sidebarResizingAtom,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from './ui-state.ts'

export function ResizeHandle() {
  const setSidebarWidth = useSetAtom(sidebarWidthAtom)
  const setResizing = useSetAtom(sidebarResizingAtom)
  const dragging = useRef(false)
  const rafRef = useRef(0)

  const cleanup = useCallback(() => {
    dragging.current = false
    setResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [setResizing])

  useEffect(() => {
    return () => {
      if (dragging.current) {
        cleanup()
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [cleanup])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      setResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      function onMouseMove(event: MouseEvent) {
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0
            const width = Math.round(clamp(event.clientX, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH))
            setSidebarWidth(width)
          })
        }
      }

      function onMouseUp() {
        cleanup()
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [setSidebarWidth, setResizing, cleanup],
  )

  const onDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }, [setSidebarWidth])

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className="group relative z-10 w-1 flex-shrink-0 cursor-col-resize"
    >
      <div
        className={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-100',
          'bg-transparent group-hover:bg-white/15 group-active:bg-white/30',
        )}
      />
    </div>
  )
}
