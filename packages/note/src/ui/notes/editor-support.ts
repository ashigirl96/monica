import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useCallback } from 'react'

import type { Doc, Note } from '../../contract.ts'
import type { BlockEditorHandle } from '../editor/block-editor.tsx'
import { stripPendingImages } from '../editor/image-upload.ts'

// autosave が保存する content から、アップロード未完了（src:null）の image block を除く。
// toJSON を持つ live doc（PMNode）はフラッシュ時に一度だけ walk するよう
// 遅延ラップし、打鍵毎の全文 walk を避ける。src:null を保存すると再読込で復元不能になる。
export function persistableContent(content: unknown): { toJSON: () => Doc } {
  return {
    toJSON: () => {
      const hasToJson = !!content && typeof (content as { toJSON?: unknown }).toJSON === 'function'
      const json = hasToJson ? (content as { toJSON: () => unknown }).toJSON() : content
      return stripPendingImages(json) as Doc
    },
  }
}

/** title 入力欄のキーハンドリング。Enter / ↓ / Tab / ⌃N で本文先頭へフォーカスを移す。 */
export function titleFieldKeyDown(
  e: ReactKeyboardEvent<HTMLInputElement>,
  focusBody: () => void,
): void {
  if (e.nativeEvent.isComposing) return
  const ctrlN = e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'n'
  if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || ctrlN) {
    e.preventDefault()
    focusBody()
  }
}

/** 本文編集の共有配線。onDocChange は最新 doc を contentRef に控えて現 note の保存を予約し、
 * focusEditorStart は本文先頭へフォーカスする。title の保存差分（kind ごと）は呼び手の
 * scheduleSave に閉じる。 */
export function useEditorDoc({
  contentRef,
  noteRef,
  editorHandleRef,
  scheduleSave,
}: {
  contentRef: RefObject<unknown>
  noteRef: RefObject<Note | null>
  editorHandleRef: RefObject<BlockEditorHandle | null>
  scheduleSave: (note: Note) => void
}) {
  const onDocChange = useCallback(
    (doc: unknown) => {
      contentRef.current = doc
      const current = noteRef.current
      if (current) scheduleSave(current)
    },
    [contentRef, noteRef, scheduleSave],
  )
  const focusEditorStart = useCallback(() => {
    editorHandleRef.current?.focusStart()
  }, [editorHandleRef])
  return { onDocChange, focusEditorStart }
}

/** ⌥K/J の巡回選択。current がリスト外（未選択・巡回対象外の項目を開いている等）の
 * ときは「リスト先頭の外側」扱い: 前進(+1)で先頭、後退(-1)で末尾へ。空リストは undefined。 */
export function cycleSelect(
  list: string[],
  current: string | null,
  step: 1 | -1,
): string | undefined {
  if (list.length === 0) return undefined
  const found = current === null ? -1 : list.indexOf(current)
  const idx = found === -1 ? (step === 1 ? -1 : 0) : found
  return list[(idx + step + list.length) % list.length]
}
