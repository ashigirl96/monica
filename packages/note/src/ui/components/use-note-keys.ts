import { useEffect } from 'react'

import { type NoteKeyHandlers, noteKeys, type Section } from '../keys.ts'

/** 処理は描画ごとに登録し直し、いつも最新の state を閉じ込めた処理を配る。 */
export function useNoteKeys(section: Section | null, handlers: NoteKeyHandlers) {
  useEffect(() => noteKeys.register(section, handlers))
}
