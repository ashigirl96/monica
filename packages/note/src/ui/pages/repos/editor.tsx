import { FuzzyPickerModal } from '@monica/ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { displayName, sameRepo } from '../../../contract.ts'
import { useNoteKeys } from '../../components/use-note-keys.ts'
import { useDocumentTitle } from '../../document-title.ts'
import type { BlockEditorHandle } from '../../editor/block-editor.tsx'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { cycleSelect, titleFieldKeyDown } from '../../notes/editor-support.ts'
import { NotePane } from '../../notes/note-pane.tsx'
import { NotesShell } from '../../notes/notes-shell.tsx'
import { useRepoCandidatesQuery, useRepoNotesQuery, useScratchQuery } from '../../notes/queries.ts'
import { useListedNotes } from '../../notes/use-listed-notes.ts'
import { navigate } from '../../router.ts'
import { repoNotePath, repoNoteRedirect, repoPath } from '../../routes.ts'
import { useSlots } from '../../slots.ts'
import { RepoSidebar } from './sidebar.tsx'
import { setLastRepo } from './support.ts'

/**
 * /repos/:owner/:repo[/notes/:id]: Repo のエディタ。noteId 無し = Scratch。
 * サイドバーは Scratch 固定 + 時系列。⌃W で Repo の切り替え、⌥N で Repo Note の作成。
 */
export function RepoEditor({ repo, noteId }: { repo: string; noteId: string | null }) {
  const { repoPanel } = useSlots()
  const [pickerOpen, setPickerOpen] = useState(false)

  const { flush } = useAutosaveContext()
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const { notes, view } = useListedNotes('repo_note')
  const { titleFocusId } = view
  const { note } = view.open

  const scratchQuery = useScratchQuery(repo)
  const scratch = scratchQuery.data ?? null
  const scratchId = scratch?.id ?? null
  const notesQuery = useRepoNotesQuery(repo)
  const candidatesQuery = useRepoCandidatesQuery(pickerOpen)
  const timeline = useMemo(
    () => notesQuery.data?.pages.flatMap((page) => page.notes) ?? null,
    [notesQuery.data],
  )
  const hasMore = notesQuery.hasNextPage
  const repoName = scratch === null ? repo : displayName(scratch)

  useEffect(() => {
    setLastRepo(repo)
  }, [repo])

  const fetched = view.open.data
  const redirect = noteId === null || fetched === undefined ? null : repoNoteRedirect(repo, fetched)
  useEffect(() => {
    if (redirect !== null) navigate(redirect, { replace: true })
  }, [redirect])

  useDocumentTitle(note === null ? repoName : displayName(note))

  const isScratch = note?.kind === 'scratch'

  // ⌥K/J の巡回対象: Scratch（先頭）＋時系列
  const cycleIds = useMemo(
    () => (scratchId === null ? [] : [scratchId, ...(timeline ?? []).map((s) => s.id)]),
    [scratchId, timeline],
  )
  const currentId = noteId ?? scratchId

  const selectNote = useCallback(
    (targetId: string | null) => {
      void flush()
      navigate(
        targetId === null || targetId === scratchId ? repoPath(repo) : repoNotePath(repo, targetId),
      )
    },
    [flush, repo, scratchId],
  )

  const loadMore = useCallback(() => {
    // 多重発火は infinite query 側が弾く。失敗は次に sentinel が見えたときに再試行される
    void notesQuery.fetchNextPage()
  }, [notesQuery])

  const switchRepo = useCallback(
    (next: string) => {
      if (sameRepo(next, repo)) return
      void flush()
      setLastRepo(next)
      navigate(repoPath(next))
    },
    [flush, repo],
  )

  const cycle = (step: 1 | -1) => {
    const next = cycleSelect(cycleIds, currentId, step)
    if (next !== undefined) selectNote(next)
  }
  useNoteKeys('repos', {
    openPicker: () => {
      // 窓が開いている間の ⌃W は、窓の「選ばずに閉じる」に素通しする
      if (pickerOpen) return false
      setPickerOpen(true)
      return true
    },
    create: () => void notes.create(),
    remove: () => {
      // Scratch は消せないので、エディタの単語の削除に素通しする
      const target = notes.listedOpenId()
      if (target === null) return false
      void notes.remove(target)
      return true
    },
    undoRemove: () => void notes.undo(),
    toggleStar: () => {
      // Scratch には Star が無いので、エディタの入力（ß）に素通しする
      const target = notes.listedOpenId()
      if (target === null) return false
      void notes.toggleStar(target)
      return true
    },
    next: () => cycle(1),
    prev: () => cycle(-1),
  })

  const focusEditorStart = useCallback(() => editorHandleRef.current?.focusStart(), [])

  const pickerItems = useMemo(
    () => (candidatesQuery.data ?? []).map((candidate) => ({ key: candidate, label: candidate })),
    [candidatesQuery.data],
  )

  return (
    <NotesShell
      sidebar={
        <RepoSidebar
          repoName={repoName}
          scratchSelected={noteId === null}
          notes={timeline}
          selectedId={currentId}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onSelectScratch={() => selectNote(null)}
          onSelect={selectNote}
          onStar={(id) => void notes.toggleStar(id)}
          onDelete={(id) => void notes.remove(id)}
          panel={repoPanel?.(repo)}
        />
      }
    >
      <NotePane
        view={view.open}
        changeBody={notes.changeBody}
        reload={notes.reload}
        autoFocus={note?.id !== titleFocusId}
        handleRef={editorHandleRef}
        onExitUp={isScratch ? undefined : () => titleRef.current?.focus()}
        renderHeader={({ note: shown, readOnly, saveStatus }) => (
          <>
            {shown.kind === 'repo_note' ? (
              <input
                // note ごとに作り直し、autoFocus を開いた note に効かせる
                key={shown.id}
                ref={titleRef}
                autoFocus={shown.id === titleFocusId}
                value={shown.title}
                placeholder="Untitled"
                readOnly={readOnly}
                onChange={(e) => notes.changeTitle(e.target.value)}
                onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
              />
            ) : (
              <h1 className="text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)]">
                {displayName(shown)}
              </h1>
            )}
            <div className="mt-2.5 flex items-center gap-2 text-xs">
              <span className="font-mono text-[0.7rem] tracking-widest text-[var(--ink-faint)] uppercase">
                {shown.kind === 'scratch' ? 'scratch' : 'note'}
              </span>
              <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
                {shown.date.replaceAll('-', '.')}
              </span>
              {saveStatus}
            </div>
          </>
        )}
      />

      {pickerOpen && (
        <FuzzyPickerModal
          items={pickerItems}
          placeholder="Switch repo…"
          onSelect={(key) => {
            if (key !== null) switchRepo(key)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </NotesShell>
  )
}
