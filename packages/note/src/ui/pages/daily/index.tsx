import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { logicalDate, type Note } from '../../../contract.ts'
import { useDocumentTitle } from '../../document-title.ts'
import type { BlockEditorHandle } from '../../editor/block-editor.tsx'
import { altOnly } from '../../keys.ts'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { addMonths, dayLabelWithYear, type Month, monthOf, sameMonth } from '../../notes/dates.ts'
import { cycleSelect, persistableContent } from '../../notes/editor-support.ts'
import { NoteBlockEditor } from '../../notes/note-block-editor.tsx'
import { readBody, UnreadableBody, UnreadableNotice } from '../../notes/note-body.tsx'
import { useServerDoc } from '../../notes/note-sync.ts'
import { NotesShell } from '../../notes/notes-shell.tsx'
import { useDailyDatesQuery, useDailyNoteQuery } from '../../notes/queries.ts'
import { SaveStatus } from '../../notes/save-status.tsx'
import { noteLabel } from '../../notes/summary.ts'
import { queryKeys } from '../../query.ts'
import { navigate } from '../../router.ts'
import { dailyPath } from '../../routes.ts'
import { DailyCalendar } from './calendar.tsx'
import { DailySidebar } from './sidebar.tsx'

/**
 * /daily/:date: 1 日 1 note の daily 専用画面。開く = get-or-create なので EmptyState も
 * 新規作成キー（⌥N）も持たない。title は日付固定で入力 UI を出さない。
 */
export function DailyPage({ date }: { date: string }) {
  // /daily を開き直すと、この画面は作り直されて今日を導き直す。
  const [today] = useState(() => logicalDate(new Date()))
  const [month, setMonth] = useState<Month>(() => monthOf(today))
  const queryClient = useQueryClient()
  const autosave = useAutosaveContext()
  const { schedule, flush } = autosave
  const editorHandleRef = useRef<BlockEditorHandle | null>(null)
  const contentRef = useRef<unknown>(null)
  const noteRef = useRef<Note | null>(null)

  useDocumentTitle(dayLabelWithYear(date))

  // 開く = 作る（get-or-create、冪等）。docKey は note id ではなく date —
  // id はフェッチするまで分からないため
  const noteQuery = useDailyNoteQuery(date)
  const { note, generation, reload } = useServerDoc({
    docKey: date,
    data: noteQuery.data,
    autosave,
    contentRef,
    noteRef,
    refetch: noteQuery.refetch,
  })

  // 描画できる note がある間はエラーを出さない。復帰時の再フェッチが一時的に失敗しても
  // エディタを unmount しないため（latch の古い content で remount され、保存済みの
  // 編集が巻き戻ってそのまま上書きされる）。
  const noteError = note === null && noteQuery.error !== null ? noteQuery.error.message : null
  const read = note === null ? null : readBody(note.content)

  const datesQuery = useDailyDatesQuery()

  useEffect(() => {
    // 空日を開いた（= その場で作成された）場合に存在日リストへ反映する。
    // 一覧の到着が後になる場合もあるので、datesQuery.data が入れ替わるたびに撃ち直す
    if (noteQuery.data === undefined) return
    queryClient.setQueryData(queryKeys.dailyDates(), (prev: string[] | undefined) =>
      prev === undefined || prev.includes(date) ? prev : [...prev, date],
    )
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- 一覧が後から届くと開いた日を含まないことがあるので、届くたびに足し直す。
  }, [date, noteQuery.data, datesQuery.data, queryClient])

  const dates = datesQuery.data ?? null

  // カレンダーの存在日ドット。dates（全期間）の membership 判定だけなので導出で足りる
  const existing = useMemo(() => new Set(dates ?? []), [dates])

  // サイドバー = 存在日 + 今日（重複排除・降順）。存在しない日はここに現れないので、
  // ⌥K/J の巡回が自動的に「空日スキップ」になる
  const sidebarDates = useMemo(() => {
    if (dates === null) return null
    return Array.from(new Set([today, ...dates]))
      .toSorted()
      .toReversed()
  }, [dates, today])

  const selectDate = useCallback(
    (day: string) => {
      void flush()
      navigate(dailyPath(day))
    },
    [flush],
  )

  const goToday = useCallback(() => {
    setMonth((m) => (sameMonth(m, monthOf(today)) ? m : monthOf(today)))
    selectDate(today)
  }, [today, selectDate])

  useEffect(() => {
    // capture phase で登録する: エディタ（ProseMirror）より先に横取りする必要がある。
    // /daily に ⌥N は無い（新規作成の概念が「日付を開く」に吸収されるため登録しない）
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || !altOnly(e)) return
      if (e.code !== 'KeyJ' && e.code !== 'KeyK') return
      e.preventDefault()
      e.stopPropagation()
      const next = cycleSelect(sidebarDates ?? [], date, e.code === 'KeyJ' ? 1 : -1)
      if (next !== undefined) selectDate(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sidebarDates, date, selectDate])

  const onDocChange = useCallback(
    (doc: unknown) => {
      contentRef.current = doc
      const current = noteRef.current
      if (current && readBody(current.content).ok) {
        // daily は title を持たないので送らない。競合通知の見出しも title ではなく日付になる
        schedule(
          current.id,
          { content: persistableContent(contentRef.current ?? current.content) },
          noteLabel(current, dayLabelWithYear(current.date)),
        )
      }
    },
    [schedule],
  )

  return (
    <NotesShell
      sidebar={
        <>
          <DailySidebar
            dates={sidebarDates}
            selectedDate={date}
            today={today}
            onSelect={selectDate}
          />
          <DailyCalendar
            month={month}
            existing={existing}
            selectedDate={date}
            today={today}
            onMonthChange={(delta) => setMonth((m) => addMonths(m, delta))}
            onSelectDay={selectDate}
            onToday={goToday}
          />
        </>
      }
    >
      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note && read ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
            <header className="pt-10">
              <div className="flex items-baseline justify-between gap-3">
                <h1 className="font-mono text-[0.8rem] tracking-widest text-[var(--ink-muted)] uppercase">
                  {dayLabelWithYear(date)}
                </h1>
                <span className="truncate text-xs">
                  <SaveStatus noteId={note.id} onReload={() => void reload()} />
                </span>
              </div>
              {!read.ok && <UnreadableNotice error={read.error} />}
            </header>
            {read.ok ? (
              <NoteBlockEditor
                note={note}
                doc={read.doc}
                generation={generation}
                autoFocus
                onDocChange={onDocChange}
                handleRef={editorHandleRef}
              />
            ) : (
              <UnreadableBody noteId={note.id} content={note.content} error={read.error} />
            )}
          </div>
        ) : null}
      </main>
    </NotesShell>
  )
}
