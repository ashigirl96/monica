import type { ReactNode, RefObject } from 'react'

import type { Note } from '../../contract.ts'
import type { BlockEditorHandle } from '../editor/block-editor.tsx'
import { NoteBlockEditor } from './note-block-editor.tsx'
import { readBody, UnreadableBody, UnreadableNotice } from './note-body.tsx'
import type { OpenNoteView } from './open-note.ts'
import { SaveStatus } from './save-status.tsx'

/** Open Note の本文の欄。見出しの中身だけを画面ごとに渡す。 */
export function NotePane({
  view,
  changeBody,
  reload,
  renderHeader,
  headerClassName = 'pt-12',
  autoFocus,
  handleRef,
  onExitUp,
}: {
  view: OpenNoteView
  changeBody: (doc: unknown) => void
  reload: () => Promise<void>
  renderHeader: (props: { note: Note; readOnly: boolean; saveStatus: ReactNode }) => ReactNode
  headerClassName?: string
  autoFocus: boolean
  handleRef: RefObject<BlockEditorHandle | null>
  onExitUp?: () => void
}) {
  const { note, generation } = view
  // 描画できる note がある間はエラーを出さない。復帰の取り直しの一時的な失敗でエディタを外すと、保存済みの編集が巻き戻る。
  const error = note === null ? view.error : null
  const read = note === null ? null : readBody(note.content)
  return (
    <main className="flex-1 [zoom:var(--note-zoom,1)] overflow-y-auto bg-[var(--paper)]">
      {error !== null ? (
        <div className="flex h-full items-center justify-center text-sm text-destructive">
          {error.message}
        </div>
      ) : note !== null && read !== null ? (
        <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
          <header className={headerClassName}>
            {renderHeader({
              note,
              readOnly: !read.ok,
              saveStatus: <SaveStatus noteId={note.id} onReload={() => void reload()} />,
            })}
            {!read.ok && <UnreadableNotice error={read.error} />}
          </header>
          {read.ok ? (
            <NoteBlockEditor
              note={note}
              doc={read.doc}
              generation={generation}
              autoFocus={autoFocus}
              onDocChange={changeBody}
              onExitUp={onExitUp}
              handleRef={handleRef}
            />
          ) : (
            <UnreadableBody noteId={note.id} content={note.content} error={read.error} />
          )}
        </div>
      ) : null}
    </main>
  )
}
