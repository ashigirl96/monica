import { FuzzyPickerModal } from '@monica/ui'
import { ORPCError } from '@orpc/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { displayName, type Note, sameRepo } from '../../../contract.ts'
import { useNoteClient } from '../../client.ts'
import { useDocumentTitle } from '../../document-title.ts'
import type { BlockEditorHandle } from '../../editor/block-editor.tsx'
import { altOnly, ctrlOnly } from '../../keys.ts'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import {
  cycleSelect,
  persistableContent,
  titleFieldKeyDown,
  useEditorDoc,
} from '../../notes/editor-support.ts'
import { NoteBlockEditor } from '../../notes/note-block-editor.tsx'
import { useServerDoc } from '../../notes/note-sync.ts'
import { NotesShell } from '../../notes/notes-shell.tsx'
import {
  useNoteQuery,
  useRepoCandidatesQuery,
  useRepoNotesCache,
  useRepoNotesQuery,
  useScratchQuery,
  useSeedNote,
} from '../../notes/queries.ts'
import { SaveStatus } from '../../notes/save-status.tsx'
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

  const autosave = useAutosaveContext()
  const { schedule, flush, discard } = autosave
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  // ⌥N で作った Repo Note は、本文ではなく title から書き始める。
  const [titleFocusId, setTitleFocusId] = useState<string | null>(null)
  const contentRef = useRef<unknown>(null)
  const noteRef = useRef<Note | null>(null)
  // Repo を切り替えると画面ごと作り直すので、取り消せるのはこの Repo で消した Note だけになる。
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

  const noteQuery = useNoteQuery(noteId)
  const redirect = noteQuery.data === undefined ? null : repoNoteRedirect(repo, noteQuery.data)
  useEffect(() => {
    if (redirect !== null) navigate(redirect, { replace: true })
  }, [redirect])

  // 表示する doc は noteId 無し = Scratch、あり = その Repo Note。latch のキーも同じ軸で切る
  const openQuery = noteId === null ? scratchQuery : noteQuery
  const { note, generation, reload, patchNote } = useServerDoc({
    docKey: noteId ?? repo,
    data: redirect === null ? openQuery.data : undefined,
    autosave,
    contentRef,
    noteRef,
    refetch: openQuery.refetch,
  })

  useDocumentTitle(note === null ? repoName : displayName(note))

  // 描画できる note がある間はエラーを出さない（Daily と同じ理由 — 復帰時の一時的な
  // 再フェッチ失敗でエディタを unmount すると、保存済みの編集が巻き戻る）。
  const loadError = note === null ? openQuery.error : null

  // 別のタブで消された Repo Note は、このタブで消したときと同じく、保存の予約を捨てて Scratch へ移る。
  const goneId = note !== null && isNotFound(noteQuery.error) ? noteId : null
  useEffect(() => {
    if (goneId === null) return
    discard(goneId)
    navigate(repoPath(repo), { replace: true })
  }, [goneId, discard, repo])

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

  const scheduleSave = useCallback(
    (target: Note) => {
      const content = persistableContent(contentRef.current ?? target.content)
      // Scratch の保存に title を付けると、server は本文ごと断る。
      const draft = target.kind === 'repo_note' ? { content, title: target.title } : { content }
      schedule(target.id, draft, displayName(target))
    },
    [schedule],
  )

  const deleteById = useCallback(
    async (targetId: string) => {
      const removed = await removals.remove(targetId, {
        editor: { noteRef, reschedule: scheduleSave },
        leave: () => navigate(repoPath(repo), { replace: true }),
      })
      if (removed) patchRepoNotes((notes) => notes.filter((s) => s.id !== targetId))
    },
    [removals, scheduleSave, repo, patchRepoNotes],
  )

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

  useEffect(() => {
    // capture phase: ProseMirror より先に横取りする
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return
      if (ctrlOnly(e) && e.code === 'KeyW') {
        e.preventDefault()
        e.stopPropagation()
        setPickerOpen(true)
        return
      }
      if (!altOnly(e)) return
      if (e.code === 'KeyN') {
        e.preventDefault()
        e.stopPropagation()
        void createNew()
        return
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        // Scratch は消せないので、エディタの単語の削除に素通しする
        const target = noteRef.current
        if (target?.kind === 'repo_note') {
          e.preventDefault()
          e.stopPropagation()
          void deleteById(target.id)
        }
        return
      }
      if (e.code === 'KeyZ') {
        e.preventDefault()
        e.stopPropagation()
        void undoDelete()
        return
      }
      if (e.code !== 'KeyJ' && e.code !== 'KeyK') return
      e.preventDefault()
      e.stopPropagation()
      const next = cycleSelect(cycleIds, currentId, e.code === 'KeyJ' ? 1 : -1)
      if (next !== undefined) selectNote(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycleIds, currentId, selectNote, createNew, deleteById, undoDelete])

  const onTitleChange = useCallback(
    (title: string) => {
      const current = noteRef.current
      if (current?.kind !== 'repo_note') return
      const next = { ...current, title }
      patchNote(next)
      scheduleSave(next)
      patchRepoNotes((notes) => notes.map((s) => (s.id === next.id ? { ...s, title } : s)))
    },
    [scheduleSave, patchNote, patchRepoNotes],
  )

  const { onDocChange, focusEditorStart } = useEditorDoc({
    contentRef,
    noteRef,
    editorHandleRef,
    scheduleSave,
  })

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
          onDelete={(id) => void deleteById(id)}
        />
      }
    >
      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {loadError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {loadError.message}
          </div>
        ) : note !== null ? (
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
                <SaveStatus noteId={note.id} onReload={() => void reload()} />
              </div>
            </header>
            <NoteBlockEditor
              note={note}
              generation={generation}
              autoFocus={note.id !== titleFocusId}
              onDocChange={onDocChange}
              onExitUp={isScratch ? undefined : () => titleRef.current?.focus()}
              handleRef={editorHandleRef}
            />
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

function isNotFound(error: Error | null): boolean {
  return error instanceof ORPCError && error.code === 'NOT_FOUND'
}
