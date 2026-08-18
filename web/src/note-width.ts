/**
 * ノート本文カラムの幅の拡張量。既定幅（760px）を 0 として何 px 広げるかを持ち、
 * :root の CSS 変数 --note-extra-w として流し込む。カラムは mx-auto で中央寄せ
 * なので、max-width に足すだけで左右へ対称に伸びる。
 */
export const NOTE_EXTRA_MAX = 520;
export const NOTE_EXTRA_STEP = 8;

const STORAGE_KEY = "monica-note-extra-w";

const clamp = (n: number) => Math.min(NOTE_EXTRA_MAX, Math.max(0, Math.round(n)));

export function noteWidthPref(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) ? clamp(raw) : 0;
}

function apply(extra: number) {
  document.documentElement.style.setProperty("--note-extra-w", `${extra}px`);
}

/** ドラッグ中のライブ反映用。永続化はしない（毎イベントの同期 I/O を避ける） */
export function applyNoteWidth(extra: number) {
  apply(clamp(extra));
}

export function setNoteWidthPref(extra: number) {
  const v = clamp(extra);
  localStorage.setItem(STORAGE_KEY, String(v));
  apply(v);
}

export function initNoteWidth() {
  apply(noteWidthPref());
}
