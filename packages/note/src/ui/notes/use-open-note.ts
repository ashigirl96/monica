import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'

import type { Note } from '../../contract.ts'
import { useNoteClient } from '../client.ts'
import { openNoteIdOfPath } from '../routes.ts'
import { useAutosaveContext } from './autosave-context.tsx'
import { emptyView, OpenNote, type OpenNoteView } from './open-note.ts'
import type { NoteQueryOptions } from './queries.ts'

/** 画面の Open Note。`key` は開く Note の名前で、替わると `options` の query へ移る。 */
export function useOpenNote(
  key: string,
  options: NoteQueryOptions,
  accepts?: (note: Note) => boolean,
): { openNote: OpenNote; view: OpenNoteView } {
  const queryClient = useQueryClient()
  const client = useNoteClient()
  const { queue, setOpenNote } = useAutosaveContext()
  const [openNote] = useState(
    () =>
      new OpenNote({
        queryClient,
        saves: queue,
        client,
        showOpen: setOpenNote,
        openId: () => openNoteIdOfPath(window.location.pathname),
      }),
  )
  // 描画の直後、入力が届く前に移る。前の Note の予約先を残す間を作らない。
  useLayoutEffect(() => openNote.open(key, options, accepts))
  useEffect(() => openNote.attach(), [openNote])
  const view = useSyncExternalStore(openNote.subscribe, openNote.view)
  return {
    openNote,
    view: view.key === key ? view : emptyView(key, view.generation),
  }
}
