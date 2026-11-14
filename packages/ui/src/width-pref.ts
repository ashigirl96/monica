/**
 * 本文カラムの幅の拡張量。既定幅を 0 として何 px 広げるかを localStorage の key に持ち、
 * :root の CSS 変数として流し込む。カラムは mx-auto で中央寄せなので、max-width に
 * 足すだけで左右へ対称に伸びる。
 */
export type WidthPref = { storageKey: string; cssVar: string }

export const WIDTH_EXTRA_MAX = 520
export const WIDTH_EXTRA_STEP = 8

const clamp = (n: number) => Math.min(WIDTH_EXTRA_MAX, Math.max(0, Math.round(n)))

export function widthPref(pref: WidthPref): number {
  const raw = Number(localStorage.getItem(pref.storageKey))
  return Number.isFinite(raw) ? clamp(raw) : 0
}

function apply(pref: WidthPref, extra: number) {
  document.documentElement.style.setProperty(pref.cssVar, `${extra}px`)
}

/** ドラッグ中のライブ反映用。永続化はしない（毎イベントの同期 I/O を避ける） */
export function applyWidth(pref: WidthPref, extra: number) {
  apply(pref, clamp(extra))
}

export function setWidthPref(pref: WidthPref, extra: number) {
  const v = clamp(extra)
  localStorage.setItem(pref.storageKey, String(v))
  apply(pref, v)
}

export function initWidth(pref: WidthPref) {
  apply(pref, widthPref(pref))
}
