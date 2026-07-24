import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockEditor, type BlockEditorHandle } from "@shared/block-editor/block-editor";
import {
  dailyNoteCounts,
  dailyNoteDates,
  getDailyNote,
  getNotesToday,
  importImageAsset,
  renderNoteMarkdown,
  uploadImageAsset,
} from "@/api";
import { navigate } from "@/app";
import type { Note } from "@/types.gen";
import type { Month } from "../notes/dates";
import {
  addMonths,
  currentMonth,
  dayLabelWithYear,
  monthOf,
  monthRange,
  sameMonth,
  todayKey,
} from "../notes/dates";
import {
  fetchLinkMetadata,
  persistableContent,
  searchNoteMentions,
  useNoteBlockResolvers,
} from "../notes/editor-support";
import { useAutosave } from "../notes/use-autosave";
import { DailyCalendar } from "./calendar";
import { DailySidebar } from "./sidebar";
import "../notes/notes.css";

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
  // daily が存在する日の降順リスト（サイドバー・⌥K/J の巡回対象）
  const [dates, setDates] = useState<string[] | null>(null);
  const [month, setMonth] = useState<Month>(currentMonth);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  // 新規日の作成後にサイドバー・カレンダーを再取得させるためのバージョン
  const [dataVersion, setDataVersion] = useState(0);
  const { schedule, flush, error: saveError } = useAutosave();
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  const contentRef = useRef<unknown>(null);
  const noteRef = useRef<Note | null>(null);

  // mention / synced block のジャンプ先は旧 /notes（essay・project note の受け皿が
  // まだ無い Phase 1 の暫定挙動）
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

  useEffect(() => {
    let cancelled = false;
    getNotesToday()
      .then((t) => {
        if (cancelled) return;
        setToday(t.date);
        setMonth((m) => (sameMonth(m, currentMonth()) ? monthOf(t.date) : m));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // date なしは「常に今日を開く」— backend の logical today を解決してから replace する
  // （boundary 前の深夜にブラウザの日付で開くと前日の daily とズレるため）
  useEffect(() => {
    if (date !== null) return;
    let cancelled = false;
    getNotesToday()
      .then((t) => {
        if (!cancelled) navigate(`/daily/${t.date}`, { replace: true });
      })
      .catch(() => {
        if (!cancelled) navigate(`/daily/${todayKey()}`, { replace: true });
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
        setDataVersion((v) => v + 1);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNoteError(e instanceof Error ? e.message : "Failed to open daily note");
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    let cancelled = false;
    dailyNoteDates()
      .then((list) => {
        // API は date 昇順 — サイドバーは降順で使う
        if (!cancelled) setDates(list.map((c) => c.date).reverse());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  useEffect(() => {
    const r = monthRange(month);
    let cancelled = false;
    dailyNoteCounts(r.from, r.to, "daily")
      .then((list) => {
        if (!cancelled) setExisting(new Set(list.map((c) => c.date)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [month, dataVersion]);

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
      const list = sidebarDates ?? [];
      if (list.length === 0) return;
      const step = e.code === "KeyJ" ? 1 : -1;
      const found = date === null ? -1 : list.indexOf(date);
      // 未選択（またはリスト外の日付）は「リスト先頭の外側」扱い: J で先頭、K で末尾へ
      const idx = found === -1 ? (step === 1 ? -1 : 0) : found;
      selectDate(list[(idx + step + list.length) % list.length]);
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
            <BlockEditor
              key={note.id}
              initialDoc={note.content}
              autoFocus
              onDocChange={onDocChange}
              fetchLinkMetadata={fetchLinkMetadata}
              searchNoteMentions={searchNoteMentions}
              resolveNoteMention={resolveNoteMention}
              onNoteMentionClick={openInNotes}
              noteId={note.id}
              resolveBlock={resolveBlock}
              onOpenBlock={onOpenBlock}
              uploadImage={uploadImageAsset}
              importExternalImage={importImageAsset}
              renderMarkdown={renderNoteMarkdown}
              handleRef={editorHandleRef}
              className="min-h-[70dvh] pt-4 pb-24"
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
