import { useCallback, useEffect, useMemo, useRef } from 'react'

import { displayName, type EssayStatus } from '../../../contract.ts'
import { useNoteKeys } from '../../components/use-note-keys.ts'
import { useDocumentTitle } from '../../document-title.ts'
import type { BlockEditorHandle } from '../../editor/block-editor.tsx'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { cycleSelect, titleFieldKeyDown } from '../../notes/editor-support.ts'
import { NotePane } from '../../notes/note-pane.tsx'
import { NotesShell } from '../../notes/notes-shell.tsx'
import { useEssaysQuery } from '../../notes/queries.ts'
import { useListedNotes } from '../../notes/use-listed-notes.ts'
import { navigate } from '../../router.ts'
import { essayPath } from '../../routes.ts'
import { EssaysSidebar } from './sidebar.tsx'
import { otherEssayTab, splitEssaysByStatus } from './support.ts'

function StatusChip({ status, onToggle }: { status: EssayStatus; onToggle: () => void }) {
  const writing = status === 'writing'
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle writing / finished (⌃W)"
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-100 hover:bg-[var(--ink-hover)]"
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: writing ? 'var(--kind-essay)' : 'var(--ink-faint)' }}
      />
      <span className="text-[var(--ink-muted)]">{status}</span>
    </button>
  )
}

/**
 * /essays/:id: サイドバーは writing / finished のタブで片方だけを並べ、⌥H/⌥L で往復する。
 * ⌥K/J は表示中のタブの中を巡回する。
 */
export function EssayEditorPage({ id }: { id: string }) {
  const { flush } = useAutosaveContext()
  const { notes, view } = useListedNotes('essay')
  const { tab, titleFocusId } = view
  const { note } = view.open
  const { data: essays = null } = useEssaysQuery()
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useDocumentTitle(note?.kind === 'essay' ? displayName(note) : null)

  // ⌥N で作った Essay は本文ではなく title から書き始める。title を離れたら手放す
  const openNoteId = note?.id ?? null
  useEffect(() => {
    if (openNoteId !== null && openNoteId === titleFocusId) titleRef.current?.focus()
  }, [openNoteId, titleFocusId])

  const groups = useMemo(() => splitEssaysByStatus(essays), [essays])
  const cycleIds = useMemo(() => (groups?.[tab] ?? []).map((s) => s.id), [groups, tab])

  const selectEssay = useCallback(
    (essayId: string) => {
      void flush()
      navigate(essayPath(essayId))
    },
    [flush],
  )

  const cycle = (step: 1 | -1) => {
    // 反対のタブに移っていると、開いている Essay は一覧の外として先頭か末尾から巡る
    const next = cycleSelect(cycleIds, id, step)
    if (next !== undefined) selectEssay(next)
  }
  // Essay でない Note はこの画面にエディタが無いので、キーは既定の動作に任せる。
  const listedOpen = (act: (essayId: string) => Promise<void>) => () => {
    const target = notes.listedOpenId()
    if (target === null) return false
    void act(target)
    return true
  }
  useNoteKeys('essays', {
    toggleStatus: listedOpen(() => notes.toggleEssayStatus()),
    create: () => void notes.create(),
    remove: listedOpen(notes.remove),
    undoRemove: () => void notes.undo(),
    toggleStar: listedOpen(notes.toggleStar),
    // ⌥H/⌥L はサイドバーに見える範囲だけを変え、開いている Essay と URL は動かさない
    switchEssayList: () => notes.setEssayTab(otherEssayTab(tab)),
    next: () => cycle(1),
    prev: () => cycle(-1),
  })

  const focusEditorStart = useCallback(() => editorHandleRef.current?.focusStart(), [])

  return (
    <NotesShell
      sidebar={
        <EssaysSidebar
          groups={groups}
          tab={tab}
          onTabChange={notes.setEssayTab}
          selectedId={id}
          onSelect={selectEssay}
          onStar={(essayId) => void notes.toggleStar(essayId)}
        />
      }
    >
      {note !== null && note.kind !== 'essay' ? (
        <main className="flex-1 [zoom:var(--note-zoom,1)] overflow-y-auto bg-[var(--paper)]">
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-faint)]">
            Not an essay — open it in Notes
          </div>
        </main>
      ) : (
        <NotePane
          view={view.open}
          changeBody={notes.changeBody}
          reload={notes.reload}
          autoFocus={note?.id !== titleFocusId}
          handleRef={editorHandleRef}
          onExitUp={() => titleRef.current?.focus()}
          renderHeader={({ note: shown, readOnly, saveStatus }) =>
            shown.kind === 'essay' && (
              <>
                <input
                  ref={titleRef}
                  value={shown.title}
                  placeholder="Untitled"
                  readOnly={readOnly}
                  onChange={(e) => notes.changeTitle(e.target.value)}
                  onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                  onBlur={notes.releaseTitleFocus}
                  className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
                />
                <div className="mt-2.5 flex items-center gap-2 text-xs">
                  <StatusChip
                    status={shown.status}
                    onToggle={() => void notes.toggleEssayStatus()}
                  />
                  <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
                    {shown.date.replaceAll('-', '.')}
                  </span>
                  {saveStatus}
                </div>
              </>
            )
          }
        />
      )}
    </NotesShell>
  )
}
