import { useEffect, useRef, useState } from 'react'

const DRAG_THRESHOLD_SQ = 25
const PRESS_FRAME_MS = 250
const ITEM_ATTR = 'data-reorder-id'
const LINE_COLOR = '#38bdf8'

export type DragPhase = 'pressed' | 'dragging'

type Press = {
  id: string
  el: HTMLElement
  startX: number
  startY: number
  offsetX: number
  offsetY: number
}

type Drag = { ghost: HTMLElement; line: HTMLElement; cursor: HTMLStyleElement; to: string | null }

// 写しは body に fixed で置くので、元の id や data-* を残すと、querySelector で元の要素と取り違える。
function ghostOf(el: HTMLElement): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement
  for (const node of [ghost, ...ghost.querySelectorAll('*')]) {
    for (const name of node.getAttributeNames()) {
      if (name === 'id' || name.startsWith('data-')) node.removeAttribute(name)
    }
  }
  const rect = el.getBoundingClientRect()
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    margin: '0',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    opacity: '0.8',
    boxShadow: 'none',
    pointerEvents: 'none',
    zIndex: '9999',
  })
  return ghost
}

function lineElement(): HTMLElement {
  const line = document.createElement('div')
  line.setAttribute('aria-hidden', 'true')
  Object.assign(line.style, {
    position: 'fixed',
    height: '2px',
    borderRadius: '1px',
    background: LINE_COLOR,
    pointerEvents: 'none',
    zIndex: '9999',
    display: 'none',
  })
  return line
}

// 子の要素が自分の cursor を持っていても、drag の間は grabbing に揃える。
function grabbingCursor(): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = '* { cursor: grabbing !important; }'
  return style
}

// 並びと交差する向きには箱の幅の中、並びの向きには隣との隙間の半分までを、その要素の上と見なす。
function dropTargetAt(source: HTMLElement, x: number, y: number) {
  const box = source.parentElement
  if (!box) return null
  const gap = Number.parseFloat(getComputedStyle(box).rowGap) || 0
  const bounds = box.getBoundingClientRect()
  if (x < bounds.left || x > bounds.right) return null
  for (const el of box.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`)) {
    if (el === source) continue
    const rect = el.getBoundingClientRect()
    if (y < rect.top - gap / 2 || y > rect.bottom + gap / 2) continue
    const after = Boolean(source.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    return {
      id: el.getAttribute(ITEM_ATTR)!,
      lineY: after ? rect.bottom + gap / 2 : rect.top - gap / 2,
      left: rect.left,
      width: rect.width,
    }
  }
  return null
}

// click と区別するため、閾値を越えて動いてから drag にする。並びは縦に限る。
export function useDragReorder(reorder: (from: string, to: string) => void) {
  const reorderRef = useRef(reorder)
  useEffect(() => {
    reorderRef.current = reorder
  })
  const pressRef = useRef<Press | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const frameTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [phase, setPhase] = useState<{ id: string; phase: DragPhase } | null>(null)

  useEffect(() => {
    const finish = (drop: boolean) => {
      const press = pressRef.current
      if (!press) return
      clearTimeout(frameTimerRef.current)
      const drag = dragRef.current
      if (drag) {
        drag.ghost.remove()
        drag.line.remove()
        drag.cursor.remove()
        if (drop && drag.to) reorderRef.current(press.id, drag.to)
      }
      pressRef.current = null
      dragRef.current = null
      setPhase(null)
    }

    const startDrag = (press: Press) => {
      clearTimeout(frameTimerRef.current)
      const drag = {
        ghost: ghostOf(press.el),
        line: lineElement(),
        cursor: grabbingCursor(),
        to: null,
      }
      document.body.append(drag.ghost, drag.line)
      document.head.append(drag.cursor)
      dragRef.current = drag
      setPhase({ id: press.id, phase: 'dragging' })
    }

    const onMove = (e: PointerEvent) => {
      const press = pressRef.current
      if (!press) return
      if (e.buttons === 0) {
        finish(true)
        return
      }
      if (!dragRef.current) {
        const dx = e.clientX - press.startX
        const dy = e.clientY - press.startY
        if (dx * dx + dy * dy <= DRAG_THRESHOLD_SQ) return
        startDrag(press)
      }
      const drag = dragRef.current!
      drag.ghost.style.left = `${e.clientX - press.offsetX}px`
      drag.ghost.style.top = `${e.clientY - press.offsetY}px`
      const target = dropTargetAt(press.el, e.clientX, e.clientY)
      drag.to = target?.id ?? null
      if (!target) {
        drag.line.style.display = 'none'
        return
      }
      Object.assign(drag.line.style, {
        display: 'block',
        left: `${target.left}px`,
        width: `${target.width}px`,
        top: `${target.lineY - 1}px`,
      })
    }

    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      finish(false)
    }
  }, [])

  const handlersFor = (id: string, onActivate?: () => void) => ({
    [ITEM_ATTR]: id,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      pressRef.current = {
        id,
        el: e.currentTarget,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      }
      clearTimeout(frameTimerRef.current)
      frameTimerRef.current = setTimeout(() => {
        if (pressRef.current?.id === id && !dragRef.current) setPhase({ id, phase: 'pressed' })
      }, PRESS_FRAME_MS)
      onActivate?.()
    },
  })

  const phaseOf = (id: string): DragPhase | null => (phase?.id === id ? phase.phase : null)

  return { handlersFor, phaseOf }
}
