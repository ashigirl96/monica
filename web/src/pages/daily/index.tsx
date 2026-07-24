import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import { dailyNoteDates, getDailyNote, getNotesToday } from "@/api";
import { navigate } from "@/app";
import type { Note } from "@/types.gen";
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
import { useAutosave } from "@/notes/use-autosave";
import { DailyCalendar } from "./calendar";
import { DailySidebar } from "./sidebar";
import "@/notes/notes.css";

/**
 * /daily: 1 日 1 note の daily 専用画面。開く = get-or-create なので EmptyState も
 * 新規作成キー（⌥N）も持たない。title は日付固定で入力 UI を出さない。
 */
export function DailyPage({ date }: { date: string | null }) {
  // logical today は backend が正（day boundary 設定を適用）。ブラウザ midnight は
  // 取得完了までの初期値フォールバック
  const [today, setToday] = useState<string>(todayKey);
  const [note, setNote] = useState<Note | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  // daily が存在する日の集合（順序不問 — サイドバー・カレンダーは導出時に整える）
  const [dates, setDates] = useState<string[] | null>(null);
  const [month, setMonth] = useState<Month>(currentMonth);
  const { schedule, flush, error: saveError } = useAutosave();
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
  useEffect(() => {
    if (date !== null && todayResolvedRef.current) return;
    let cancelled = false;
    getNotesToday()
      .then((t) => {
        if (cancelled) return;
        todayResolvedRef.current = true;
        setToday(t.date);
        setMonth((m) => (sameMonth(m, currentMonth()) ? monthOf(t.date) : m));
        if (date === null) navigate(`/daily/${t.date}`, { replace: true });
      })
      .catch(() => {
        if (!cancelled && date === null) navigate(`/daily/${todayKey()}`, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  // 開く = 作る（get-or-create、冪等）
  useEffect(() => {
    if (date === null) return;
    mentionCacheRef.current = new Map();
    let cancelled = false;
    noteRef.current = null;
    setNote(null);
    setNoteError(null);
    getDailyNote(date)
      .then((n) => {
        if (cancelled) return;
        contentRef.current = n.content;
        noteRef.current = n;
        setNote(n);
        // 空日を開いた（= その場で作成された）場合に存在日リストへ反映する
        setDates((prev) => (prev?.includes(date) ? prev : [...(prev ?? []), date]));
      })
      .catch((e: unknown) => {
        if (!cancelled) setNoteError(e instanceof Error ? e.message : "Failed to open daily note");
      });
    return () => {
      cancelled = true;
    };
  }, [date, mentionCacheRef]);

  // synced block ジャンプの対象がロードされたらスクロールする。別 note からの cross-note
  // ジャンプは /notes/{id} リダイレクト経由でこのページに着地する
  useEffect(() => {
    if (!note) return;
    const blockId = takePendingBlockTarget(note.id);
    if (blockId) editorHandleRef.current?.scrollToBlock(blockId);
  }, [note]);

  useEffect(() => {
    let cancelled = false;
    dailyNoteDates()
      .then((list) => {
        if (cancelled) return;
        // 取得中に get-or-create で足された日付（note 読み込み effect の setDates）を
        // レスポンスで潰さないよう合併する
        setDates((prev) => {
          const merged = new Set(list.map((c) => c.date));
          for (const d of prev ?? []) merged.add(d);
          return Array.from(merged);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
      if (e.isComposing) return;
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
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
    <div
      className="notes-screen relative flex h-dvh shrink-0 overflow-hidden"
      data-density="relaxed"
    >
      <aside className="w-[300px] shrink-0 overflow-hidden border-r transition-[width] duration-200 group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0 motion-reduce:transition-none">
        {/* 開閉アニメーション中に中身が折り返さないよう幅は内側で固定する */}
        <div className="flex h-full w-[300px] flex-col">
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
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note && date !== null ? (
          <div className="mx-auto w-full max-w-[760px] px-10">
            <header className="flex items-baseline justify-between gap-3 pt-10">
              <h1 className="font-mono text-[0.8rem] uppercase tracking-widest text-[var(--ink-muted)]">
                {dayLabelWithYear(date)}
              </h1>
              {saveError && (
                <span className="truncate text-xs text-destructive">Save failed — {saveError}</span>
              )}
            </header>
            <NoteBlockEditor
              note={note}
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
    </div>
  );
}
