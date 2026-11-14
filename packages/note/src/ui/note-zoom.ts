/**
 * ノート本文の拡大率。ブラウザの ⌘+・⌘-・⌘0 はサイドバーまで大きくするので、ページ側で
 * 受け取り、:root の CSS 変数 --note-zoom として本文のスクロール枠の zoom に流し込む。
 */
import { nextZoom, ZOOM_STEPS, type ZoomStep } from '@monica/ui'

import { noteKeys } from './keys.ts'

const STORAGE_KEY = 'monica-note-zoom'

export function noteZoomPref(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY))
  return ZOOM_STEPS.includes(raw) ? raw : 1
}

function apply(zoom: number) {
  document.documentElement.style.setProperty('--note-zoom', String(zoom))
}

export function initNoteZoom(): () => void {
  let zoom = noteZoomPref()
  apply(zoom)
  const to = (step: ZoomStep) => {
    zoom = nextZoom(zoom, step)
    apply(zoom)
    localStorage.setItem(STORAGE_KEY, String(zoom))
  }
  return noteKeys.register(null, {
    zoomIn: () => to('in'),
    zoomOut: () => to('out'),
    zoomReset: () => to('reset'),
  })
}
