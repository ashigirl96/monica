/**
 * ノート本文の拡大率。ブラウザの ⌘+・⌘-・⌘0 はサイドバーまで大きくするので、ページ側で
 * 受け取り、:root の CSS 変数 --note-zoom として本文のスクロール枠の zoom に流し込む。
 */
// Chromium のページ拡大と同じ段階にし、ブラウザの拡大と同じ手触りにする。
export const NOTE_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

const STORAGE_KEY = 'monica-note-zoom'

export function noteZoomPref(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY))
  return NOTE_ZOOM_STEPS.includes(raw) ? raw : 1
}

/** 拡大縮小のキーなら次の拡大率、それ以外は null。 */
export function nextNoteZoom(zoom: number, e: KeyboardEvent): number | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const i = NOTE_ZOOM_STEPS.indexOf(zoom)
  const at = (j: number) => NOTE_ZOOM_STEPS[Math.min(NOTE_ZOOM_STEPS.length - 1, Math.max(0, j))]!
  // JIS 配列は ; のキーに + があり、Chrome はそこでの ⌘; を拡大として扱う。
  if (['+', '=', ';'].includes(e.key) || e.code === 'NumpadAdd') return at(i + 1)
  if (e.key === '-' || e.code === 'NumpadSubtract') return at(i - 1)
  if (e.key === '0' || e.code === 'Numpad0') return 1
  return null
}

function apply(zoom: number) {
  document.documentElement.style.setProperty('--note-zoom', String(zoom))
}

export function initNoteZoom(): () => void {
  let zoom = noteZoomPref()
  apply(zoom)
  const onKeyDown = (e: KeyboardEvent) => {
    const next = nextNoteZoom(zoom, e)
    if (next === null) return
    e.preventDefault()
    zoom = next
    apply(zoom)
    localStorage.setItem(STORAGE_KEY, String(zoom))
  }
  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}
