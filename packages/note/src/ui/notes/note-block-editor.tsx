import type { RefObject } from 'react'

import type { Note } from '../../contract.ts'
import { BlockEditor, type BlockEditorHandle } from '../editor/block-editor.tsx'

export function NoteBlockEditor({
  note,
  generation,
  autoFocus,
  onDocChange,
  onExitUp,
  handleRef,
}: {
  note: Note
  /** 外部更新を採用したときだけ進む世代。自分の autosave では進まないので、
   * 打鍵のたびに再マウントしてカーソルと undo を失うことがない。 */
  generation: number
  autoFocus: boolean
  onDocChange: (doc: unknown) => void
  onExitUp?: () => void
  handleRef: RefObject<BlockEditorHandle | null>
}) {
  return (
    <BlockEditor
      key={`${note.id}:${generation}`}
      initialDoc={note.content}
      autoFocus={autoFocus}
      onDocChange={onDocChange}
      onExitUp={onExitUp}
      handleRef={handleRef}
      className="min-h-[70dvh] pt-4 pb-[40dvh]"
    />
  )
}
