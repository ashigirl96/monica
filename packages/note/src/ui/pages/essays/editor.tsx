import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { displayName, type EssayStatus, type Note } from '../../../contract.ts'
import { useNoteClient } from '../../client.ts'
import { useDocumentTitle } from '../../document-title.ts'
import type { BlockEditorHandle } from '../../editor/block-editor.tsx'
import { altOnly, ctrlOnly } from '../../keys.ts'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { cycleSelect, persistableContent, titleFieldKeyDown } from '../../notes/editor-support.ts'
import { NoteBlockEditor } from '../../notes/note-block-editor.tsx'
import { useServerDoc } from '../../notes/note-sync.ts'
import { NotesShell } from '../../notes/notes-shell.tsx'
import {
  useEssaysCache,
  useEssaysQuery,
  useForgetNote,
  useNoteQuery,
  useSeedNote,
} from '../../notes/queries.ts'
import { SaveStatus } from '../../notes/save-status.tsx'
import { noteLabel } from '../../notes/summary.ts'
import { navigate } from '../../router.ts'
import { ESSAYS_PATH, essayPath } from '../../routes.ts'
import { removeOpenEssay, setOpenEssayStatus } from './actions.ts'
import { EssaysSidebar } from './sidebar.tsx'
import {
  dropEssay,
  otherEssayTab,
  patchEssay,
  pushDeletedEssay,
  restoreLastDeletedEssay,
  splitEssaysByStatus,
} from './support.ts'

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
  const client = useNoteClient()
  // ⌥H/⌥L の手動の切り替えと、開いた Essay の status への同期で動く
  const [tab, setTab] = useState<EssayStatus>('writing')
  const autosave = useAutosaveContext()
  const { schedule, flush, discard, resume, setBase, hasUnsaved } = autosave
  const { data: essays = null } = useEssaysQuery()
  const { patchEssays, invalidateEssays } = useEssaysCache()
  const seedNote = useSeedNote()
  const forgetNote = useForgetNote()
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  // ⌥N で作った Essay は本文ではなく title から書き始める。title を離れたら手放す
  const [titleFirst, setTitleFirst] = useState<string | null>(null)
  const contentRef = useRef<unknown>(null)
  // onDocChange は BlockEditor の再レンダーより先に呼ばれうるので、closure の note ではなく
  // 常に最新を持つ ref から保存を組み立てる
  const noteRef = useRef<Note | null>(null)
  const openIdRef = useRef(id)

  useEffect(() => {
    openIdRef.current = id
  }, [id])

  const noteQuery = useNoteQuery(id)
  const { note, generation, reload, patch, adopt } = useServerDoc({
    docKey: id,
    data: noteQuery.data,
    autosave,
    contentRef,
    noteRef,
    refetch: noteQuery.refetch,
  })

  // 描画できる note がある間はエラーを出さない（Daily と同じく、復帰の取り直しの一時的な失敗で
  // エディタを外すと、保存済みの編集が巻き戻る）。
  const noteError = note === null && noteQuery.error !== null ? noteQuery.error.message : null

  useDocumentTitle(note?.kind === 'essay' ? displayName(note) : null)

  const openNoteId = note?.id ?? null
  useEffect(() => {
    if (openNoteId !== null && openNoteId === titleFirst) titleRef.current?.focus()
  }, [openNoteId, titleFirst])

  const openStatus = note?.kind === 'essay' ? note.status : null
  const [synced, setSynced] = useState<{ id: string; status: EssayStatus | null }>({
    id,
    status: openStatus,
  })
  if (synced.id !== id || synced.status !== openStatus) {
    // 開いた Essay の status へタブを移すのは、開いた時と status が変わった時だけ。
    // 常に合わせると ⌥H/⌥L で移した瞬間に引き戻される。
    setSynced({ id, status: openStatus })
    if (openStatus !== null) setTab(openStatus)
  }

  const groups = useMemo(() => splitEssaysByStatus(essays), [essays])
  // ⌥K/J と削除の後の送り先
  const cycleIds = useMemo(() => (groups?.[tab] ?? []).map((s) => s.id), [groups, tab])

  const selectEssay = useCallback(
    (essayId: string) => {
      void flush()
      navigate(essayPath(essayId))
    },
    [flush],
  )

  const scheduleSave = useCallback(
    (target: Note) => {
      if (target.kind !== 'essay') return
      schedule(
        target.id,
        {
          title: target.title,
          content: persistableContent(contentRef.current ?? target.content),
        },
        noteLabel(target, 'Untitled'),
      )
    },
    [schedule],
  )

  const createNew = useCallback(async () => {
    await flush()
    try {
      const created = await client.essay.create()
      setTitleFirst(created.id)
      // 先に cache へ置いてから移ると、loading を挟まずに描ける
      seedNote(created)
      navigate(essayPath(created.id))
      invalidateEssays()
    } catch {
      // 作れなくても次の ⌥N で作り直せる
    }
  }, [client, flush, seedNote, invalidateEssays])

  const deleteCurrent = useCallback(async () => {
    const removed = await removeOpenEssay({
      gate: noteRef,
      isOpen: (essayId) => openIdRef.current === essayId,
      flush,
      hasUnsaved,
      remove: (essayId) => client.remove({ id: essayId }),
      reschedule: scheduleSave,
    })
    if (removed === null) return
    // 消した Essay への保存の再試行が NOT_FOUND を繰り返さないよう止める
    discard(removed.id)
    forgetNote(removed.id)
    pushDeletedEssay(removed.id)
    patchEssays((list) => dropEssay(list, removed.id))
    if (openIdRef.current !== removed.id) return
    // 表示中のタブにあった Essay はタブの次へ送って書く流れを切らない。タブの外の Essay は
    // 送り先が画面に見えていないので一覧へ帰す
    const next = cycleIds.includes(removed.id) ? cycleSelect(cycleIds, removed.id, 1) : undefined
    navigate(next !== undefined && next !== removed.id ? essayPath(next) : ESSAYS_PATH, {
      replace: true,
    })
  }, [client, flush, hasUnsaved, discard, forgetNote, scheduleSave, cycleIds, patchEssays])

  const undoDelete = useCallback(async () => {
    const restored = await restoreLastDeletedEssay((essayId) => client.restore({ id: essayId }))
    if (restored === undefined) return
    resume(restored.id)
    invalidateEssays()
    seedNote(restored)
    navigate(essayPath(restored.id))
  }, [client, seedNote, resume, invalidateEssays])

  // 連打した 2 回が同じ status を読んで 1 回に潰れないよう、切り替えを直列にする
  const statusChainRef = useRef<Promise<void>>(Promise.resolve())

  const toggleStatus = useCallback(() => {
    // 押した時の Essay が対象。順番を待つ間に別の Essay へ移ったら何もしない
    const targetId = noteRef.current?.id
    if (targetId === undefined) return
    const run = async () => {
      try {
        const updated = await setOpenEssayStatus({
          targetId,
          gate: noteRef,
          shownContent: () => persistableContent(contentRef.current).toJSON(),
          flush,
          hasUnsaved,
          setStatus: (essayId, status) => client.essay.setStatus({ id: essayId, status }),
          setBase,
          adopt: (next, remount) => {
            seedNote(next)
            adopt(next, remount)
          },
          patchStatus: (status) =>
            patch((current) => (current.kind === 'essay' ? { ...current, status } : current)),
        })
        if (updated?.kind === 'essay') {
          patchEssays((list) => patchEssay(list, updated.id, { status: updated.status }))
        }
      } catch {
        // 手元の一覧が古いだけなので、取り直せば追いつく
        invalidateEssays()
      }
    }
    statusChainRef.current = statusChainRef.current.then(run)
  }, [client, flush, hasUnsaved, setBase, seedNote, adopt, patch, patchEssays, invalidateEssays])

  useEffect(() => {
    // エディタ（ProseMirror）より先に取るため capture phase で張る
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return
      if (ctrlOnly(e) && e.code === 'KeyW' && noteRef.current !== null) {
        e.preventDefault()
        e.stopPropagation()
        toggleStatus()
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
        if (noteRef.current === null) return
        e.preventDefault()
        e.stopPropagation()
        void deleteCurrent()
        return
      }
      if (e.code === 'KeyZ') {
        e.preventDefault()
        e.stopPropagation()
        void undoDelete()
        return
      }
      // ⌥H/⌥L はサイドバーに見える範囲だけを変え、開いている Essay と URL は動かさない
      if (e.code === 'KeyH' || e.code === 'KeyL') {
        e.preventDefault()
        e.stopPropagation()
        setTab(otherEssayTab)
        return
      }
      if (e.code !== 'KeyJ' && e.code !== 'KeyK') return
      e.preventDefault()
      e.stopPropagation()
      // 反対のタブに移っていると、開いている Essay は一覧の外として先頭か末尾から巡る
      const next = cycleSelect(cycleIds, id, e.code === 'KeyJ' ? 1 : -1)
      if (next !== undefined) selectEssay(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cycleIds, id, selectEssay, createNew, toggleStatus, deleteCurrent, undoDelete])

  const onTitleChange = useCallback(
    (title: string) => {
      const current = noteRef.current
      if (current?.kind !== 'essay') return
      const next: Note = { ...current, title }
      patch(() => next)
      scheduleSave(next)
      patchEssays((list) => patchEssay(list, next.id, { title }))
    },
    [scheduleSave, patch, patchEssays],
  )

  const onDocChange = useCallback(
    (doc: unknown) => {
      contentRef.current = doc
      const current = noteRef.current
      if (current) scheduleSave(current)
    },
    [scheduleSave],
  )

  const focusEditorStart = useCallback(() => editorHandleRef.current?.focusStart(), [])

  return (
    <NotesShell
      sidebar={
        <EssaysSidebar
          groups={groups}
          tab={tab}
          onTabChange={setTab}
          selectedId={id}
          onSelect={selectEssay}
        />
      }
    >
      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note !== null && note.kind === 'essay' ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
            <header className="pt-12">
              <input
                ref={titleRef}
                value={note.title}
                placeholder="Untitled"
                onChange={(e) => onTitleChange(e.target.value)}
                onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                onBlur={() => setTitleFirst(null)}
                className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
              />
              <div className="mt-2.5 flex items-center gap-2 text-xs">
                <StatusChip status={note.status} onToggle={toggleStatus} />
                <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
                  {note.date.replaceAll('-', '.')}
                </span>
                <SaveStatus noteId={note.id} onReload={() => void reload()} />
              </div>
            </header>
            <NoteBlockEditor
              note={note}
              generation={generation}
              autoFocus={note.id !== titleFirst}
              onDocChange={onDocChange}
              onExitUp={() => titleRef.current?.focus()}
              handleRef={editorHandleRef}
            />
          </div>
        ) : note !== null ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-faint)]">
            Not an essay — open it in Notes
          </div>
        ) : null}
      </main>
    </NotesShell>
  )
}
