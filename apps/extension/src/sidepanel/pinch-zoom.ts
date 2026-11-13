export type View = { scale: number; x: number; y: number }

const MAX_SCALE = 5

/** 指の下の点を動かさずに、ピンチ 1 回分だけ拡大率を変える。 */
export function pinch(
  view: View,
  deltaY: number,
  px: number,
  py: number,
  w: number,
  h: number,
): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale * Math.exp(-deltaY * 0.01)))
  const k = scale / view.scale
  return clamp({ scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k }, w, h)
}

export function pan(view: View, dx: number, dy: number, w: number, h: number): View {
  return clamp({ ...view, x: view.x - dx, y: view.y - dy }, w, h)
}

function clamp({ scale, x, y }: View, w: number, h: number): View {
  return {
    scale,
    x: Math.min(0, Math.max(w - w * scale, x)),
    y: Math.min(0, Math.max(h - h * scale, y)),
  }
}

function scrollsInside(from: EventTarget | null, axis: 'x' | 'y', delta: number): boolean {
  if (delta === 0) return true
  for (let el = from instanceof Element ? from : null; el; el = el.parentElement) {
    const overflow = getComputedStyle(el)[axis === 'x' ? 'overflowX' : 'overflowY']
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const [pos, size, view] =
      axis === 'x'
        ? [el.scrollLeft, el.scrollWidth, el.clientWidth]
        : [el.scrollTop, el.scrollHeight, el.clientHeight]
    if (delta < 0 ? pos > 0 : pos + view < size - 1) return true
  }
  return false
}

/**
 * Chrome の side panel はピンチで拡大しないので、tab と同じく見た目だけを拡大する。
 * 拡大中のスクロールは、中のスクロール領域が動けない向きの分だけ見る位置を動かす。
 */
export function magnifyOnPinch(target: HTMLElement): void {
  let view: View = { scale: 1, x: 0, y: 0 }
  const apply = (next: View) => {
    view = next
    const zoomed = view.scale > 1
    target.style.transformOrigin = zoomed ? '0 0' : ''
    target.style.transform = zoomed
      ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
      : ''
    // clip だと html の scrollbar-gutter が外れて、拡大の出入りで幅が変わる。
    document.documentElement.style.overflow = zoomed ? 'hidden' : ''
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault()
        apply(pinch(view, e.deltaY, e.clientX, e.clientY, innerWidth, innerHeight))
        return
      }
      if (view.scale === 1) return
      const dx = scrollsInside(e.target, 'x', e.deltaX) ? 0 : e.deltaX
      const dy = scrollsInside(e.target, 'y', e.deltaY) ? 0 : e.deltaY
      if (dx !== 0 || dy !== 0) apply(pan(view, dx, dy, innerWidth, innerHeight))
    },
    { passive: false },
  )
}
