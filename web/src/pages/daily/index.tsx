import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import { queryKeys } from "@/query";
import { navigate } from "@/app";
import { altOnly } from "@/keys";
import type { DailyNoteCount, Note } from "@/types.gen";
import type { Month } from "@/notes/dates";
import { takePendingBlockTarget } from "@/notes/block-jump";
import {
  addMonths,
  currentMonth,
  dayLabelWithYear,
  monthOf,
  sameMonth,
  todayKey,
} from "@/notes/dates";
import { cycleSelect, persistableContent, useNoteBlockResolvers } from "@/notes/editor-support";
import { NoteBlockEditor } from "@/notes/note-block-editor";
import { useServerDoc } from "@/notes/note-sync";
import { NotesShell } from "@/notes/notes-shell";
import { useDailyDatesQuery, useDailyNoteQuery, useNotesTodayQuery } from "@/notes/queries";
import { SaveStatus } from "@/notes/save-status";
import { useAutosave } from "@/notes/use-autosave";
import { DailyCalendar } from "./calendar";
import { DailySidebar } from "./sidebar";

/**
 * /daily: 1 日 1 note の daily 専用画面。開く = get-or-create なので EmptyState も
 * 新規作成キー（⌥N）も持たない。title は日付固定で入力 UI を出さない。
 */
export function DailyPage({ date }: { date: string | null }) {
  // logical today は backend が正（day boundary 設定を適用）。ブラウザ midnight は
  // 取得完了までの初期値フォールバック
  const [today, setToday] = useState<string>(todayKey);
  const [month, setMonth] = useState<Month>(currentMonth);
  const queryClient = useQueryClient();
  const autosave = useAutosave();
  const { schedule, flush, error: saveError, conflictId } = autosave;
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  const contentRef = useRef<unknown>(null);
  const noteRef = useRef<Note | null>(null);

  // mention / synced block のジャンプ先。`/notes/{id}` は NoteRedirect が kind に応じて
  // /daily・/essays・/projects へ振り分ける（本文に埋まった href を壊さないため経路を温存）
  const openInNotes = useCallback(
    (noteId: string) => {
      void flush();
      navigate(`/notes/${noteId}`);
    },
    [flush],
  );

  const { mentionCacheRef, resolveNoteMention, resolveBlock, onOpenBlock } = useNoteBlockResolvers({
    flush,
    noteRef,
    editorHandleRef,
    onNavigateToNote: openInNotes,
  });

  // date なしは「常に今日を開く」— backend の logical today を解決してから replace する
  // （boundary 前の深夜にブラウザの日付で開くと前日の daily とズレるため）。解決済みなら
  // 日付間の移動では再取得せず、素の /daily へ戻ったときだけ取り直す
  const todayResolvedRef = useRef(false);
  const todayQuery = useNotesTodayQuery(date === null || !todayResolvedRef.current);
  useEffect(() => {
    const resolved = todayQuery.data;
    if (resolved !== undefined) {
      todayResolvedRef.current = true;
      setToday(resolved.date);
      setMonth((m) => (sameMonth(m, currentMonth()) ? monthOf(resolved.date) : m));
      if (date === null) navigate(`/daily/${resolved.date}`, { replace: true });
      return;
    }
    if (todayQuery.error !== null && date === null) {
      navigate(`/daily/${todayKey()}`, { replace: true });
    }
  }, [todayQuery.data, todayQuery.error, date]);

  // 開く = 作る（get-or-create、冪等）。docKey は note id ではなく date —
  // id はフェッチするまで分からないため
  const noteQuery = useDailyNoteQuery(date);
  const { note, generation, reload } = useServerDoc({
    docKey: date ?? "",
    data: noteQuery.data,
    autosave,
    contentRef,
    noteRef,
    refetch: noteQuery.refetch,
  });

  // 描画できる note がある間はエラーを出さない。復帰時の再フェッチが一時的に失敗しても
  // エディタを unmount しないため（latch の古い content で remount され、保存済みの
  // 編集が巻き戻ってそのまま上書きされる）。
  const noteError = note === null && noteQuery.error !== null ? noteQuery.error.message : null;

  useEffect(() => {
    // 別 note の mention 解決結果を持ち越さない
    mentionCacheRef.current = new Map();
  }, [date, mentionCacheRef]);

  const datesQuery = useDailyDatesQuery();

  useEffect(() => {
    // 空日を開いた（= その場で作成された）場合に存在日リストへ反映する。
    // 一覧の到着が後になる場合もあるので、datesQuery.data が入れ替わるたびに撃ち直す
    if (date === null || noteQuery.data === undefined) return;
    queryClient.setQueryData(queryKeys.dailyDates(), (prev: DailyNoteCount[] | undefined) =>
      prev === undefined || prev.some((c) => c.date === date)
        ? prev
        : [...prev, { date, count: 1 }],
    );
  }, [date, noteQuery.data, datesQuery.data, queryClient]);

  // synced block ジャンプの対象がロードされたらスクロールする。別 note からの cross-note
  // ジャンプは /notes/{id} リダイレクト経由でこのページに着地する
  useEffect(() => {
    if (!note) return;
    const blockId = takePendingBlockTarget(note.id);
    if (blockId) editorHandleRef.current?.scrollToBlock(blockId);
  }, [note]);

  const dates = useMemo(
    () => (datesQuery.data === undefined ? null : datesQuery.data.map((c) => c.date)),
    [datesQuery.data],
  );

  // カレンダーの存在日ドット。dates（全期間）の membership 判定だけなので導出で足りる
  const existing = useMemo(() => new Set(dates ?? []), [dates]);

  // サイドバー = 存在日 + 今日（重複排除・降順）。存在しない日はここに現れないので、
  // ⌥K/J の巡回が自動的に「空日スキップ」になる
  const sidebarDates = useMemo(() => {
    if (dates === null) return null;
    return Array.from(new Set([today, ...dates]))
      .sort()
      .reverse();
  }, [dates, today]);

  const selectDate = useCallback(
    (day: string) => {
      void flush();
      navigate(`/daily/${day}`);
    },
    [flush],
  );

  const goToday = useCallback(() => {
    setMonth((m) => (sameMonth(m, monthOf(today)) ? m : monthOf(today)));
    selectDate(today);
  }, [today, selectDate]);

  useEffect(() => {
    // capture phase で登録する: エディタ（ProseMirror）より先に横取りする必要がある。
    // /daily に ⌥N は無い（新規作成の概念が「日付を開く」に吸収されるため登録しない）
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || !altOnly(e)) return;
      if (e.code !== "KeyJ" && e.code !== "KeyK") return;
      e.preventDefault();
      e.stopPropagation();
      const next = cycleSelect(sidebarDates ?? [], date, e.code === "KeyJ" ? 1 : -1);
      if (next !== undefined) selectDate(next);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sidebarDates, date, selectDate]);

  const onDocChange = useCallback(
    (doc: unknown) => {
      contentRef.current = doc;
      const current = noteRef.current;
      if (current) {
        // daily は title を持たないので常に null（essay の title 置換経路は通らない）
        schedule(current.id, {
          title: null,
          content: persistableContent(contentRef.current ?? current.content),
        });
      }
    },
    [schedule],
  );

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
        ) : note && date !== null ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
            <header className="flex items-baseline justify-between gap-3 pt-10">
              <h1 className="font-mono text-[0.8rem] uppercase tracking-widest text-[var(--ink-muted)]">
                {dayLabelWithYear(date)}
              </h1>
              <span className="truncate text-xs">
                <SaveStatus
                  saveError={saveError}
                  conflict={conflictId === note.id}
                  onReload={() => void reload()}
                />
              </span>
            </header>
            <NoteBlockEditor
              note={note}
              generation={generation}
              autoFocus
              onDocChange={onDocChange}
              onNoteMentionClick={openInNotes}
              resolveNoteMention={resolveNoteMention}
              resolveBlock={resolveBlock}
              onOpenBlock={onOpenBlock}
              handleRef={editorHandleRef}
            />
          </div>
        ) : null}
      </main>
    </NotesShell>
  );
}
