import type { BlockEditorHandle } from '@monica/block-editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { displayName, type EssayStatus } from '../../../contract.ts'
import { useNoteClient } from '../../client.ts'
import { useNoteKeys } from '../../components/use-note-keys.ts'
import { useDocumentTitle } from '../../document-title.ts'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { cycleSelect, titleFieldKeyDown } from '../../notes/editor-support.ts'
import { NoteBlockEditor } from '../../notes/note-block-editor.tsx'
import { readBody, UnreadableBody, UnreadableNotice } from '../../notes/note-body.tsx'
import { NotesShell } from '../../notes/notes-shell.tsx'
import {
  noteQueryOptions,
  useEssaysCache,
  useEssaysQuery,
  useSeedNote,
} from '../../notes/queries.ts'
import { SaveStatus } from '../../notes/save-status.tsx'
import { useToggleStar } from '../../notes/star.tsx'
import { useOpenNote } from '../../notes/use-open-note.ts'
import { useRemovals } from '../../notes/use-removals.ts'
import { navigate } from '../../router.ts'
import { ESSAYS_PATH, essayPath } from '../../routes.ts'
import { EssaysSidebar } from './sidebar.tsx'
import { dropEssay, otherEssayTab, patchEssay, splitEssaysByStatus } from './support.ts'

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
  const { flush } = useAutosaveContext()
  const removals = useRemovals('essay')
  const { data: essays = null } = useEssaysQuery()
  const { patchEssays, invalidateEssays } = useEssaysCache()
  const seedNote = useSeedNote()
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  // ⌥N で作った Essay は本文ではなく title から書き始める。title を離れたら手放す
  const [titleFirst, setTitleFirst] = useState<string | null>(null)

  const { openNote, view } = useOpenNote(id, noteQueryOptions(client, id))
  const { note, generation } = view

  // 描画できる note がある間はエラーを出さない（Daily と同じく、復帰の取り直しの一時的な失敗で
  // エディタを外すと、保存済みの編集が巻き戻る）。
  const noteError = note === null && view.error !== null ? view.error.message : null
  const read = note === null ? null : readBody(note.content)

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
  // focus で一覧の取り直しが Essay の取り直しより先に返ると、外で消された Essay は並びから消えている。
  const listedCycleRef = useRef<{ tab: EssayStatus; ids: string[] } | null>(null)
  useEffect(() => {
    if (cycleIds.includes(id)) listedCycleRef.current = { tab, ids: cycleIds }
  }, [cycleIds, id, tab])

  const selectEssay = useCallback(
    (essayId: string) => {
      void flush()
      navigate(essayPath(essayId))
    },
    [flush],
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

  const leaveEssay = useCallback(
    (targetId: string, ids: string[] = cycleIds) => {
      // 表示中のタブにあった Essay はタブの次へ送って書く流れを切らない。タブの外の Essay は
      // 送り先が画面に見えていないので一覧へ帰す
      const next = ids.includes(targetId) ? cycleSelect(ids, targetId, 1) : undefined
      navigate(next !== undefined && next !== targetId ? essayPath(next) : ESSAYS_PATH, {
        replace: true,
      })
    },
    [cycleIds],
  )

  const deleteEssay = useCallback(
    async (targetId: string) => {
      const removed = await openNote.remove(targetId, removals, () => leaveEssay(targetId))
      if (removed) patchEssays((list) => dropEssay(list, targetId))
    },
    [openNote, removals, leaveEssay, patchEssays],
  )

  const goneId = view.gone
  useEffect(() => {
    if (goneId === null) return
    const listed = listedCycleRef.current
    const ids = listed?.tab === tab ? listed.ids : cycleIds
    removals.removedElsewhere(goneId, { leave: () => leaveEssay(goneId, ids) })
  }, [goneId, removals, leaveEssay, tab, cycleIds])

  const undoDelete = useCallback(async () => {
    const restored = await removals.undo()
    if (restored === null) return
    invalidateEssays()
    seedNote(restored)
    navigate(essayPath(restored.id))
  }, [removals, seedNote, invalidateEssays])

  const toggleStar = useToggleStar(invalidateEssays)

  const toggleStatus = useCallback(async () => {
    try {
      const updated = await openNote.toggleStatus()
      if (updated?.kind === 'essay') {
        patchEssays((list) => patchEssay(list, updated.id, { status: updated.status }))
      }
    } catch {
      // 手元の一覧が古いだけなので、取り直せば追いつく
      invalidateEssays()
    }
  }, [openNote, patchEssays, invalidateEssays])

  const cycle = (step: 1 | -1) => {
    // 反対のタブに移っていると、開いている Essay は一覧の外として先頭か末尾から巡る
    const next = cycleSelect(cycleIds, id, step)
    if (next !== undefined) selectEssay(next)
  }
  useNoteKeys('essays', {
    toggleStatus: () => {
      if (openNote.editing === null) return false
      void toggleStatus()
      return true
    },
    create: () => void createNew(),
    remove: () => {
      // 種類の違う Note はこの画面にエディタが無く、単語の削除に渡す先が無いので、それでも呑む
      const target = openNote.editing
      if (target === null) return false
      void deleteEssay(target.id)
      return true
    },
    undoRemove: () => void undoDelete(),
    toggleStar: () => {
      const target = openNote.editing
      if (target?.kind !== 'essay') return false
      void toggleStar(target.id)
      return true
    },
    // ⌥H/⌥L はサイドバーに見える範囲だけを変え、開いている Essay と URL は動かさない
    switchEssayList: () => setTab(otherEssayTab),
    next: () => cycle(1),
    prev: () => cycle(-1),
  })

  const onTitleChange = useCallback(
    (title: string) => {
      const next = openNote.changeTitle(title)
      if (next !== null) patchEssays((list) => patchEssay(list, next.id, { title }))
    },
    [openNote, patchEssays],
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
          onStar={(essayId) => void toggleStar(essayId)}
        />
      }
    >
      <main className="flex-1 [zoom:var(--note-zoom,1)] overflow-y-auto bg-[var(--paper)]">
        {noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note !== null && read !== null && note.kind === 'essay' ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
            <header className="pt-12">
              <input
                ref={titleRef}
                value={note.title}
                placeholder="Untitled"
                readOnly={!read.ok}
                onChange={(e) => onTitleChange(e.target.value)}
                onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                onBlur={() => setTitleFirst(null)}
                className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
              />
              <div className="mt-2.5 flex items-center gap-2 text-xs">
                <StatusChip status={note.status} onToggle={() => void toggleStatus()} />
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
                autoFocus={note.id !== titleFirst}
                onDocChange={openNote.changeBody}
                onExitUp={() => titleRef.current?.focus()}
                handleRef={editorHandleRef}
              />
            ) : (
              <UnreadableBody noteId={note.id} content={note.content} error={read.error} />
            )}
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
