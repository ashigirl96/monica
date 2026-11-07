import { FuzzyPickerModal } from '@monica/ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { displayName, type Note, sameRepo } from '../../../contract.ts'
import { useNoteClient } from '../../client.ts'
import { useNoteKeys } from '../../components/use-note-keys.ts'
import { useDocumentTitle } from '../../document-title.ts'
import type { BlockEditorHandle } from '../../editor/block-editor.tsx'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { cycleSelect, titleFieldKeyDown } from '../../notes/editor-support.ts'
import { NoteBlockEditor } from '../../notes/note-block-editor.tsx'
import { readBody, UnreadableBody, UnreadableNotice } from '../../notes/note-body.tsx'
import { NotesShell } from '../../notes/notes-shell.tsx'
import {
  noteQueryOptions,
  scratchQueryOptions,
  useRepoCandidatesQuery,
  useRepoNotesCache,
  useRepoNotesQuery,
  useScratchQuery,
  useSeedNote,
} from '../../notes/queries.ts'
import { SaveStatus } from '../../notes/save-status.tsx'
import { useToggleStar } from '../../notes/star.tsx'
import { useOpenNote } from '../../notes/use-open-note.ts'
import { useRemovals } from '../../notes/use-removals.ts'
import { navigate } from '../../router.ts'
import { repoNotePath, repoNoteRedirect, repoPath } from '../../routes.ts'
import { RepoSidebar } from './sidebar.tsx'
import { setLastRepo } from './support.ts'

/**
 * /repos/:owner/:repo[/notes/:id]: Repo のエディタ。noteId 無し = Scratch。
 * サイドバーは Scratch 固定 + 時系列。⌃W で Repo の切り替え、⌥N で Repo Note の作成。
 */
export function RepoEditor({ repo, noteId }: { repo: string; noteId: string | null }) {
  const client = useNoteClient()
  const [pickerOpen, setPickerOpen] = useState(false)

  const { flush } = useAutosaveContext()
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  // ⌥N で作った Repo Note は、本文ではなく title から書き始める。
  const [titleFocusId, setTitleFocusId] = useState<string | null>(null)
  const removals = useRemovals('repo_note')

  const scratchQuery = useScratchQuery(repo)
  const scratch = scratchQuery.data ?? null
  const scratchId = scratch?.id ?? null
  const notesQuery = useRepoNotesQuery(repo)
  const { patchRepoNotes, invalidateRepoNotes } = useRepoNotesCache(repo)
  const seedNoteInCache = useSeedNote()
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

  // 表示する doc は noteId 無し = Scratch、あり = その Repo Note。開く Note の名前も同じ軸で切る
  const { openNote, view } = useOpenNote(
    noteId ?? repo,
    noteId === null ? scratchQueryOptions(client, repo) : noteQueryOptions(client, noteId),
    (fetched: Note) => noteId === null || repoNoteRedirect(repo, fetched) === null,
  )
  const { note, generation } = view
  const redirect =
    noteId === null || view.data === undefined ? null : repoNoteRedirect(repo, view.data)
  useEffect(() => {
    if (redirect !== null) navigate(redirect, { replace: true })
  }, [redirect])

  useDocumentTitle(note === null ? repoName : displayName(note))

  // 描画できる note がある間はエラーを出さない（Daily と同じ理由 — 復帰時の一時的な
  // 再フェッチ失敗でエディタを unmount すると、保存済みの編集が巻き戻る）。
  const loadError = note === null ? view.error : null
  const read = note === null ? null : readBody(note.content)

  const goneId = view.gone
  useEffect(() => {
    if (goneId === null) return
    removals.removedElsewhere(goneId, {
      leave: () => navigate(repoPath(repo), { replace: true }),
    })
  }, [goneId, removals, repo])

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

  const createNew = useCallback(async () => {
    await flush()
    try {
      const created = await client.repoNote.create({ repo })
      setTitleFocusId(created.id)
      // 先にキャッシュへ置いてから遷移する（loading を挟まず即描画される）
      seedNoteInCache(created)
      navigate(repoNotePath(repo, created.id))
      invalidateRepoNotes()
    } catch {
      // 作成失敗は次の ⌥N で再試行できるので黙って握る
    }
  }, [client, flush, repo, seedNoteInCache, invalidateRepoNotes])

  const loadMore = useCallback(() => {
    // 多重発火は infinite query 側が弾く。失敗は次に sentinel が見えたときに再試行される
    void notesQuery.fetchNextPage()
  }, [notesQuery])

  const deleteById = useCallback(
    async (targetId: string) => {
      const removed = await openNote.remove(targetId, removals, () =>
        navigate(repoPath(repo), { replace: true }),
      )
      if (removed) patchRepoNotes((notes) => notes.filter((s) => s.id !== targetId))
    },
    [openNote, removals, repo, patchRepoNotes],
  )

  const toggleStar = useToggleStar(invalidateRepoNotes)

  const undoDelete = useCallback(async () => {
    const restored = await removals.undo()
    if (restored === null) return
    invalidateRepoNotes()
    seedNoteInCache(restored)
    navigate(repoNotePath(repo, restored.id))
  }, [removals, invalidateRepoNotes, seedNoteInCache, repo])

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
    openPicker: () => setPickerOpen(true),
    create: () => void createNew(),
    remove: () => {
      // Scratch は消せないので、エディタの単語の削除に素通しする
      const target = openNote.editing
      if (target?.kind !== 'repo_note') return false
      void deleteById(target.id)
      return true
    },
    undoRemove: () => void undoDelete(),
    toggleStar: () => {
      // Scratch には Star が無いので、エディタの入力（ß）に素通しする
      const target = openNote.editing
      if (target?.kind !== 'repo_note') return false
      void toggleStar(target.id)
      return true
    },
    next: () => cycle(1),
    prev: () => cycle(-1),
  })

  const onTitleChange = useCallback(
    (title: string) => {
      const next = openNote.changeTitle(title)
      if (next === null) return
      patchRepoNotes((notes) => notes.map((s) => (s.id === next.id ? { ...s, title } : s)))
    },
    [openNote, patchRepoNotes],
  )

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
          onStar={(id) => void toggleStar(id)}
          onDelete={(id) => void deleteById(id)}
        />
      }
    >
      <main className="flex-1 [zoom:var(--note-zoom,1)] overflow-y-auto bg-[var(--paper)]">
        {loadError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {loadError.message}
          </div>
        ) : note !== null && read !== null ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
            <header className="pt-12">
              {note.kind === 'repo_note' ? (
                <input
                  // note ごとに作り直し、autoFocus を開いた note に効かせる
                  key={note.id}
                  ref={titleRef}
                  autoFocus={note.id === titleFocusId}
                  value={note.title}
                  placeholder="Untitled"
                  readOnly={!read.ok}
                  onChange={(e) => onTitleChange(e.target.value)}
                  onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                  className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
                />
              ) : (
                <h1 className="text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)]">
                  {displayName(note)}
                </h1>
              )}
              <div className="mt-2.5 flex items-center gap-2 text-xs">
                <span className="font-mono text-[0.7rem] tracking-widest text-[var(--ink-faint)] uppercase">
                  {isScratch ? 'scratch' : 'note'}
                </span>
                <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
                  {note.date.replaceAll('-', '.')}
                </span>
                <SaveStatus noteId={note.id} onReload={() => void openNote.reload()} />
              </div>
              {!read.ok && <UnreadableNotice error={read.error} />}
            </header>
            {read.ok ? (
              <NoteBlockEditor
                note={note}
                doc={read.doc}
                generation={generation}
                autoFocus={note.id !== titleFocusId}
                onDocChange={openNote.changeBody}
                onExitUp={isScratch ? undefined : () => titleRef.current?.focus()}
                handleRef={editorHandleRef}
              />
            ) : (
              <UnreadableBody noteId={note.id} content={note.content} error={read.error} />
            )}
          </div>
        ) : null}
      </main>

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
