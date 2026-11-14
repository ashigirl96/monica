import { type PointerEvent as ReactPointerEvent, useEffect, useState } from 'react'

export type ResizableWidth = {
  storageKey: string
  initial: number
  min: number
  max: number
  /** 窓幅のうちこの欄に渡さない幅（rail と本文の最小幅）。欄が本文と境界を画面外へ押し出さないため */
  reserved: number
  /** 右端の欄は、境界を左へ引くと広がる */
  grows?: 'right' | 'left'
  /** 欄が CSS の zoom の内側にあるときの拡大率。ポインターと窓幅は拡大後の px で届く */
  scale?: number
}

/**
 * 欄の幅をドラッグで変える。希望幅を localStorage に残し、表示だけ窓幅に合わせて抑えるので、
 * 窓を広げれば元の幅に戻る。境界のダブルクリックで既定幅に戻す。
 */
export function useResizableWidth({
  storageKey,
  initial,
  min,
  max,
  reserved,
  grows = 'right',
  scale = 1,
}: ResizableWidth) {
  const clamp = (w: number, upper = max) => Math.min(upper, Math.max(min, w))
  const [width, setWidth] = useState(() => {
    const raw = Number(localStorage.getItem(storageKey))
    return raw > 0 ? clamp(raw) : initial
  })
  // ドラッグ開始時の座標と幅。null = ドラッグ中でない
  const [resizeStart, setResizeStart] = useState<{ x: number; w: number } | null>(null)
  // コンテナ幅ではなく窓幅を見るのは、コンテナ幅が内容依存でループになるため
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const upper = clamp(viewport / scale - reserved)
  const shown = clamp(width, upper)
  const resizing = resizeStart !== null

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    // ドラッグ中は書かない。毎フレームの同期 I/O になるので、離した一度だけ永続化する
    if (resizing) return
    localStorage.setItem(storageKey, String(width))
  }, [resizing, width, storageKey])

  useEffect(() => {
    if (resizeStart === null) return
    let frame = 0
    let pending: number | null = null
    const sign = grows === 'right' ? 1 : -1
    const widthAt = (clientX: number) =>
      Math.min(upper, Math.max(min, resizeStart.w + (sign * (clientX - resizeStart.x)) / scale))
    const commit = () => {
      frame = 0
      if (pending !== null) setWidth(pending)
      pending = null
    }
    // 終了イベントは解放位置を持っているので、それを最後の幅として必ず反映する。
    // 予約済みフレームを取り消すだけだと、素早いドラッグで幅が変わらないまま終わる
    const finish = (clientX?: number) => {
      cancelAnimationFrame(frame)
      if (clientX !== undefined) pending = widthAt(clientX)
      commit()
      setResizeStart(null)
    }
    const onMove = (e: PointerEvent) => {
      // WKWebView は pointerup を取りこぼし buttons=0 の move が先に来ることがある
      if (e.buttons === 0) {
        finish(e.clientX)
        return
      }
      // 幅は本文の祖先に載るので、1 フレームに複数届く pointermove をそのまま反映すると
      // 本文全体の style 再計算を余分に回す
      pending = widthAt(e.clientX)
      if (frame === 0) frame = requestAnimationFrame(commit)
    }
    const onUp = (e: PointerEvent) => finish(e.clientX)
    const onCancel = () => finish()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [resizeStart, upper, min, grows, scale])

  return {
    width: shown,
    resizing,
    separatorProps: {
      onPointerDown: (e: ReactPointerEvent) => {
        e.preventDefault()
        setResizeStart({ x: e.clientX, w: shown })
      },
      onDoubleClick: () => setWidth(initial),
    },
  }
}
