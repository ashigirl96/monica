/**
 * ノート本文の拡大率。ブラウザの ⌘+・⌘-・⌘0 はサイドバーまで大きくするので、ページ側で
 * 受け取り、:root の CSS 変数 --note-zoom として本文のスクロール枠の zoom に流し込む。
 */
import { noteKeys } from './keys.ts'

// Chromium のページ拡大と同じ段階にし、ブラウザの拡大と同じ手触りにする。
export const NOTE_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

const STORAGE_KEY = 'monica-note-zoom'

export function noteZoomPref(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY))
  return NOTE_ZOOM_STEPS.includes(raw) ? raw : 1
}

export type NoteZoomStep = 'in' | 'out' | 'reset'

export function nextNoteZoom(zoom: number, step: NoteZoomStep): number {
  if (step === 'reset') return 1
  const i = NOTE_ZOOM_STEPS.indexOf(zoom) + (step === 'in' ? 1 : -1)
  return NOTE_ZOOM_STEPS[Math.min(NOTE_ZOOM_STEPS.length - 1, Math.max(0, i))]!
}

function apply(zoom: number) {
  document.documentElement.style.setProperty('--note-zoom', String(zoom))
}

export function initNoteZoom(): () => void {
  let zoom = noteZoomPref()
  apply(zoom)
  const to = (step: NoteZoomStep) => {
    zoom = nextNoteZoom(zoom, step)
    apply(zoom)
    localStorage.setItem(STORAGE_KEY, String(zoom))
  }
  return noteKeys.register(null, {
    zoomIn: () => to('in'),
    zoomOut: () => to('out'),
    zoomReset: () => to('reset'),
  })
}
