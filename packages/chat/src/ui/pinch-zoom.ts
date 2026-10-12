import { useEffect, useState } from 'react'

const MIN = 0.8
const MAX = 2
const KEY = 'monica.chat.zoom'

/** トラックパッドのピンチ 1 回分の deltaY から、次の拡大率を出す。 */
export function nextZoom(current: number, deltaY: number): number {
  return Math.min(MAX, Math.max(MIN, current * Math.exp(-deltaY * 0.01)))
}

function storedZoom(): number {
  try {
    const value = Number(localStorage.getItem(KEY))
    return value >= MIN && value <= MAX ? value : 1
  } catch {
    return 1
  }
}

/** ピンチで変わる会話の拡大率。Chrome はピンチを ctrlKey 付きの wheel として送る。 */
export function usePinchZoom(): number {
  const [zoom, setZoom] = useState(storedZoom)

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      setZoom((current) => nextZoom(current, event.deltaY))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(zoom))
    } catch {}
  }, [zoom])

  return zoom
}
