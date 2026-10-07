import { type RefObject, useCallback, useEffect, useState } from 'react'

import type { Note } from '../../contract.ts'
import { reach, useNoteClient } from '../client.ts'
import { BlockEditor, type BlockEditorHandle } from '../editor/block-editor.tsx'
import { navigate } from '../router.ts'
import { notePath } from '../routes.ts'
import { useAutosaveContext } from './autosave-context.tsx'
import { arrivalAt, jumpToBlock } from './block-jump.ts'
import { imageCallbacks } from './editor-support.ts'
import { noteReferences } from './note-references.ts'

type NoteBlockEditorProps = {
  note: Note
  /** 外部更新を採用したときだけ進む世代。自分の autosave では進まないので、
   * 打鍵のたびに再マウントしてカーソルと undo を失うことがない。 */
  generation: number
  autoFocus: boolean
  onDocChange: (doc: unknown) => void
  onExitUp?: () => void
  handleRef: RefObject<BlockEditorHandle | null>
}

// Note を開き直すたびに作り直し、Note Mention の表示名を引き直す。
export function NoteBlockEditor(props: NoteBlockEditorProps) {
  return <OpenNoteEditor key={props.note.id} {...props} />
}

function OpenNoteEditor({
  note,
  generation,
  autoFocus,
  onDocChange,
  onExitUp,
  handleRef,
}: NoteBlockEditorProps) {
  const client = useNoteClient()
  const { flush } = useAutosaveContext()
  const [references] = useState(() => noteReferences({ client, reach, flush }))
  const { uploadImage, importExternalImage } = imageCallbacks(client)
  const noteId = note.id
  const [arrival] = useState(() => arrivalAt(noteId))

  const openNote = useCallback(
    (id: string) => {
      void flush()
      navigate(notePath(id))
    },
    [flush],
  )

  const openBlock = useCallback(
    (targetNoteId: string, blockId: string) =>
      jumpToBlock({ noteId: targetNoteId, blockId }, noteId, {
        scrollToBlock: (id) => handleRef.current?.scrollToBlock(id),
        openNote,
      }),
    [noteId, handleRef, openNote],
  )

  // 子のエディタの mount の effect が handleRef を置いた後に走る。
  useEffect(() => {
    const blockId = arrival()
    if (blockId !== null) handleRef.current?.scrollToBlock(blockId)
  }, [arrival, handleRef])

  return (
    <BlockEditor
      key={generation}
      initialDoc={note.content}
      autoFocus={autoFocus}
      onDocChange={onDocChange}
      uploadImage={uploadImage}
      importExternalImage={importExternalImage}
      onExitUp={onExitUp}
      // 失敗した呼び出しは、link-menu が値の無い OGP として扱う。
      fetchLinkMetadata={(url) => client.linkMetadata({ url })}
      noteId={noteId}
      searchNoteMentions={references.searchNoteMentions}
      resolveNoteMention={references.resolveNoteMention}
      onNoteMentionClick={openNote}
      resolveBlock={references.resolveBlock}
      onOpenBlock={openBlock}
      handleRef={handleRef}
      className="min-h-[70dvh] pt-4 pb-[40dvh]"
    />
  )
}
