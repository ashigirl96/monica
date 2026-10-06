import type { RefObject } from 'react'

import type { Note } from '../../contract.ts'
import { useNoteClient } from '../client.ts'
import { BlockEditor, type BlockEditorHandle } from '../editor/block-editor.tsx'

export function NoteBlockEditor({
  note,
  generation,
  autoFocus,
  onDocChange,
  handleRef,
}: {
  note: Note
  /** 外部更新を採用したときだけ進む世代。自分の autosave では進まないので、
   * 打鍵のたびに再マウントしてカーソルと undo を失うことがない。 */
  generation: number
  autoFocus: boolean
  onDocChange: (doc: unknown) => void
  handleRef: RefObject<BlockEditorHandle | null>
}) {
  const client = useNoteClient()
  return (
    <BlockEditor
      key={`${note.id}:${generation}`}
      initialDoc={note.content}
      autoFocus={autoFocus}
      onDocChange={onDocChange}
      // 失敗した呼び出しは、link-menu が値の無い OGP として扱う。
      fetchLinkMetadata={(url) => client.linkMetadata({ url })}
      handleRef={handleRef}
      className="min-h-[70dvh] pt-4 pb-[40dvh]"
    />
  )
}
