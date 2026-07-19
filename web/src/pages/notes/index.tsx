import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BlockEditor, type BlockEditorHandle } from "@shared/block-editor/block-editor";
import { stripPendingImages } from "@shared/block-editor/image-upload";
import type { LinkMetadata } from "@shared/block-editor/link-menu";
import type { NoteMentionItem } from "@shared/block-editor/note-mention-menu";
import type { NoteMentionInfo } from "@shared/block-editor/node-views";
import { fuzzyMatch } from "@shared/fuzzy-picker/use-fuzzy-picker";
import {
  createNote,
  dailyNoteCounts,
  deleteNote,
  fetchLinkPreview,
  getNote,
  getNoteBlock,
  getNotesToday,
  importImageAsset,
  listNotes,
  listProjectNotes,
  listProjects,
  resolveNoteMention as resolveNoteMentionApi,
  restoreNote,
  searchNoteMentions as searchNoteMentionsApi,
  setNoteKind,
  uploadImageAsset,
} from "@/api";
import { navigate } from "@/app";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";
import type { Note, NoteSummary, ProjectOption } from "@/types.gen";
import type { DateRange, Month } from "./dates";
import {
  addMonths,
  currentMonth,
  monthOf,
  monthRange,
  rollingWeek,
  sameMonth,
  sameRange,
  todayKey,
  weekOf,
} from "./dates";
import { type DraftPatch, EditorHeader } from "./editor-header";
import { NotesCalendar } from "./calendar";
import { NotesSidebar, ProjectNotesSidebar, summaryTitle } from "./sidebar";
import { useAutosave } from "./use-autosave";
import "./notes.css";

async function fetchLinkMetadata(url: string): Promise<LinkMetadata | null> {
  const preview = await fetchLinkPreview(url);
  if (!preview) return null;
  return {
    title: preview.title,
    description: preview.description,
    image: preview.image,
    favicon: preview.favicon,
    siteName: preview.site_name,
  };
}

async function searchNoteMentions(query: string): Promise<NoteMentionItem[]> {
  const mentions = await searchNoteMentionsApi(query);
  return mentions.map((m) => ({ id: m.id, displayName: m.display_name, preview: m.preview }));
}

// autosave が保存する content から、アップロード未完了（src:null）の image block を除く。
// toJSON を持つ live doc（PMNode）はフラッシュ時（JSON.stringify）に一度だけ walk するよう
// 遅延ラップし、打鍵毎の全文 walk を避ける。src:null を保存すると再読込で復元不能になる。
function persistableContent(content: unknown): unknown {
  return {
    toJSON: () => {
      const hasToJson = !!content && typeof (content as { toJSON?: unknown }).toJSON === "function";
      const json = hasToJson ? (content as { toJSON: () => unknown }).toJSON() : content;
      return stripPendingImages(json);
    },
  };
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg text-[var(--ink-muted)]">No note for today</p>
      <p className="text-sm text-[var(--ink-faint)]">
        Press{" "}
        <kbd className="rounded border border-[var(--ink-border)] px-1.5 py-0.5 font-mono text-xs">
          ⌥N
        </kbd>{" "}
        to start writing
      </p>
    </div>
  );
}

const SIDEBAR_KEY = "monica-notes-sidebar-w";
const SIDEBAR_DEFAULT = 400;
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 720;

const clampSidebar = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

function readSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_KEY));
  return raw > 0 ? clampSidebar(raw) : SIDEBAR_DEFAULT;
}

export function NotesPage({ id }: { id: string | null }) {
  // logical today は backend が正（day boundary 設定を適用）。ブラウザ midnight は
  // 取得完了までの初期値フォールバック
  const [today, setToday] = useState<string>(todayKey);
  const [range, setRange] = useState<DateRange>(() => rollingWeek(todayKey()));
  const [summaries, setSummaries] = useState<NoteSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [month, setMonth] = useState<Month>(currentMonth);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  // create / delete 後に summaries と counts を再取得させるためのバージョン
  const [dataVersion, setDataVersion] = useState(0);
  // 同時に 1 つしか開かない modal picker。null = どれも閉じている
  const [picker, setPicker] = useState<"project" | "filter" | null>(null);
  // ⌃T の project filter モード。null = 通常の週表示
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [projectNotes, setProjectNotes] = useState<NoteSummary[] | null>(null);
  const [projectHasMore, setProjectHasMore] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; w: number } | null>(null);
  const loadingMoreRef = useRef(false);
  const { schedule, flush, discard, error: saveError } = useAutosave();
  const titleRef = useRef<HTMLInputElement>(null);
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  // alt+n 直後は本文ではなくタイトルへフォーカスする（ノート読み込み後の effect で消費）
  const pendingTitleFocusRef = useRef(false);
  // picker を閉じたら開く直前のフォーカス位置（タイトル/本文）へ戻す
  const pickerReturnFocusRef = useRef<HTMLElement | null>(null);
  // alt+z で復元する削除履歴（新しいものが末尾）
  const undoStackRef = useRef<string[]>([]);
  const contentRef = useRef<unknown>(null);
  // onDocChange は BlockEditor の再レンダー前に発火し得るため、closure の note ではなく
  // 常に最新のフィールドを持つ ref から保存 payload を組み立てる（stale title/kind の逆行防止）
  const noteRef = useRef<Note | null>(null);
  // 同一 doc 内の重複 mention を 1 リクエストに畳む Promise 共有キャッシュ。
  // 開くノートが変わるたび捨てるので、開き直しで表示名が最新タイトルに追従する
  const mentionCacheRef = useRef(new Map<string, Promise<NoteMentionInfo | null>>());
  // 別ノートの synced block へジャンプする際、navigate → 再マウントを跨いで対象 block を運ぶ。
  // BlockEditor は key={note.id} で再マウントされるので、ロード後の effect で消費する。
  const pendingBlockTargetRef = useRef<{ noteId: string; blockId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listNotes(range.from, range.to)
      .then((list) => {
        if (cancelled) return;
        setSummaries(list);
        setListError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : "Failed to load notes");
      });
    return () => {
      cancelled = true;
    };
  }, [range, dataVersion]);

  useEffect(() => {
    const r = monthRange(month);
    let cancelled = false;
    dailyNoteCounts(r.from, r.to)
      .then((list) => {
        if (!cancelled) setCounts(new Map(list.map((c) => [c.date, c.count])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [month, dataVersion]);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getNotesToday()
      .then((t) => {
        if (cancelled) return;
        setToday(t.date);
        // ユーザーがまだ範囲・月を動かしていなければ、初期表示も logical today 基準に合わせる
        // （boundary で today が前月に食い込むケースでカレンダーとサイドバーがズレないように）
        setRange((r) => (sameRange(r, rollingWeek(todayKey())) ? rollingWeek(t.date) : r));
        setMonth((m) => (sameMonth(m, currentMonth()) ? monthOf(t.date) : m));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (projectFilter === null) {
      setProjectNotes(null);
      setProjectHasMore(false);
      return;
    }
    let cancelled = false;
    listProjectNotes(projectFilter, 0)
      .then((page) => {
        if (cancelled) return;
        setProjectNotes(page.items);
        setProjectHasMore(page.has_more);
        setListError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : "Failed to load notes");
      });
    return () => {
      cancelled = true;
    };
  }, [projectFilter, dataVersion]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return;
    const stop = () => {
      resizeStartRef.current = null;
      setResizing(false);
    };
    const onMove = (e: PointerEvent) => {
      // WKWebView は pointerup を取りこぼし buttons=0 の move が先に来ることがある
      if (e.buttons === 0) {
        stop();
        return;
      }
      const start = resizeStartRef.current;
      if (start) setSidebarWidth(clampSidebar(start.w + (e.clientX - start.x)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      resizeStartRef.current = { x: e.clientX, w: sidebarWidth };
      setResizing(true);
    },
    [sidebarWidth],
  );

  const loadMoreProjectNotes = useCallback(async () => {
    if (projectFilter === null || projectNotes === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const page = await listProjectNotes(projectFilter, projectNotes.length);
      setProjectNotes((prev) => {
        // page 0 の再取得（dataVersion 更新）と競合しても重複させない
        const seen = new Set((prev ?? []).map((s) => s.id));
        return [...(prev ?? []), ...page.items.filter((s) => !seen.has(s.id))];
      });
      setProjectHasMore(page.has_more);
    } catch {
      // 失敗は次に sentinel が見えたときに再試行される
    } finally {
      loadingMoreRef.current = false;
    }
  }, [projectFilter, projectNotes]);

  // サイドバーに表示中のリスト。project filter 中は fuzzy 絞り込みも掛かった状態で、
  // alt+j/k の巡回対象もこれに揃える
  const displayedSummaries = useMemo(() => {
    if (projectFilter === null) return summaries;
    if (projectNotes === null) return null;
    return projectNotes.filter((s) => fuzzyMatch(summaryTitle(s), sidebarQuery));
  }, [projectFilter, projectNotes, sidebarQuery, summaries]);

  const clearProjectFilter = useCallback(() => {
    setProjectFilter(null);
    setSidebarQuery("");
  }, []);

  useEffect(() => {
    mentionCacheRef.current = new Map();
    if (id === null) {
      noteRef.current = null;
      setNote(null);
      setNoteError(null);
      return;
    }
    // create / restore 直後はレスポンスで seed 済み（noteRef が既に同じ id）なので再フェッチしない
    if (noteRef.current?.id === id) return;
    let cancelled = false;
    noteRef.current = null;
    setNote(null);
    setNoteError(null);
    getNote(id)
      .then((n) => {
        if (cancelled) return;
        contentRef.current = n.content;
        noteRef.current = n;
        setNote(n);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNoteError(e instanceof Error ? e.message : "Failed to load note");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // id なしで開いたら今日の最新エントリを自動選択する（project filter 中はしない）
  useEffect(() => {
    if (id !== null || summaries === null || projectFilter !== null) return;
    const newest = summaries.find((s) => s.date === today);
    if (newest) navigate(`/notes/${newest.id}`, { replace: true });
  }, [id, summaries, projectFilter, today]);

  // synced block ジャンプの対象ノートがロードされたらスクロールする。子（BlockEditor）の
  // mount effect が先に走って handleRef を張るので、ここで scrollToBlock を呼べる。
  useEffect(() => {
    const target = pendingBlockTargetRef.current;
    if (target && note && target.noteId === note.id) {
      pendingBlockTargetRef.current = null;
      editorHandleRef.current?.scrollToBlock(target.blockId);
    }
  }, [note]);

  const selectNote = useCallback(
    (noteId: string) => {
      void flush();
      navigate(`/notes/${noteId}`);
    },
    [flush],
  );

  const resolveNoteMention = useCallback((noteId: string): Promise<NoteMentionInfo | null> => {
    const cache = mentionCacheRef.current;
    let promise = cache.get(noteId);
    if (!promise) {
      promise = resolveNoteMentionApi(noteId).then((m) =>
        m ? { displayName: m.display_name } : null,
      );
      cache.set(noteId, promise);
    }
    return promise;
  }, []);

  // synced block（transclusion）の内容解決。キャッシュしないのは、通信エラー時に retry で
  // 再フェッチさせるため（NodeView が reject を error 状態として扱う）。
  // 別ノート参照は HTTP で解決するので、直前の編集が debounce 中／in-flight だと stale を読む。
  // ノート切替は flush を await せず navigate するため、pending PUT の完了を待ってから GET する
  // （cross-note ミラーは一度しか解決しないので stale がそのまま残る）。
  const resolveBlock = useCallback(
    async (noteId: string, blockId: string): Promise<unknown | null> => {
      await flush();
      const r = await getNoteBlock(noteId, blockId);
      return r?.block ?? null;
    },
    [flush],
  );

  // synced block のジャンプ。同一ノートなら直接スクロール、別ノートなら navigate 後に
  // 再マウントを跨いで対象を運ぶ（onNoteMentionClick={selectNote} の延長）。
  const onOpenBlock = useCallback(
    (targetNoteId: string, blockId: string) => {
      if (targetNoteId === noteRef.current?.id) {
        editorHandleRef.current?.scrollToBlock(blockId);
        return;
      }
      pendingBlockTargetRef.current = { noteId: targetNoteId, blockId };
      void flush();
      navigate(`/notes/${targetNoteId}`);
    },
    [flush],
  );

  // 「今日の直近7日 + 今日の月」へ戻す。既に同じ表示なら state 同一性を保って refetch を抑止する
  const resetToToday = useCallback(() => {
    setRange((r) => (sameRange(r, rollingWeek(today)) ? r : rollingWeek(today)));
    setMonth((m) => (sameMonth(m, monthOf(today)) ? m : monthOf(today)));
  }, [today]);

  // API レスポンスの note をそのまま表示状態にする（navigate 後の再フェッチを省く）
  const seedNote = useCallback((n: Note) => {
    contentRef.current = n.content;
    noteRef.current = n;
    setNote(n);
    setNoteError(null);
  }, []);

  const createNew = useCallback(async () => {
    await flush();
    try {
      const created = await createNote();
      // 新規 note は daily（title なし）で生まれるので、filter を解いて「今日」の文脈に戻す
      clearProjectFilter();
      resetToToday();
      setDataVersion((v) => v + 1);
      seedNote(created);
      navigate(`/notes/${created.id}`);
    } catch {
      // 作成失敗は次の ⌥N で再試行できるので黙って握る
    }
  }, [flush, resetToToday, seedNote, clearProjectFilter]);

  useEffect(() => {
    if (note && pendingTitleFocusRef.current) {
      pendingTitleFocusRef.current = false;
      titleRef.current?.focus();
    }
  }, [note]);

  // タイトルからの移動は常に本文の先頭行へ
  const focusEditorStart = useCallback(() => {
    editorHandleRef.current?.focusStart();
  }, []);

  const openPicker = useCallback((which: "project" | "filter") => {
    pickerReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setPicker(which);
  }, []);

  const toggleProjectFilter = useCallback(() => {
    if (projectFilter !== null) {
      clearProjectFilter();
      return;
    }
    openPicker("filter");
  }, [projectFilter, clearProjectFilter, openPicker]);

  useEffect(() => {
    if (picker !== null) return;
    const el = pickerReturnFocusRef.current;
    if (el) {
      pickerReturnFocusRef.current = null;
      el.focus();
    }
  }, [picker]);

  const deleteById = useCallback(
    async (noteId: string) => {
      // pending の編集を先に確定させる: 破棄してしまうと restore が編集前の行に巻き戻る
      await flush();
      discard(noteId);
      try {
        await deleteNote(noteId);
      } catch {
        return;
      }
      undoStackRef.current.push(noteId);
      setSummaries((list) => list?.filter((s) => s.id !== noteId) ?? list);
      setProjectNotes((list) => list?.filter((s) => s.id !== noteId) ?? list);
      setDataVersion((v) => v + 1);
      if (id === noteId) navigate("/notes", { replace: true });
    },
    [flush, discard, id],
  );

  const undoDelete = useCallback(async () => {
    const noteId = undoStackRef.current.pop();
    if (!noteId) return;
    let restored: Note;
    try {
      restored = await restoreNote(noteId);
    } catch {
      return;
    }
    setDataVersion((v) => v + 1);
    seedNote(restored);
    navigate(`/notes/${noteId}`);
  }, [seedNote]);

  const scheduleSave = useCallback(
    (target: Note) => {
      schedule(target.id, {
        title: target.kind.kind === "essay" ? target.kind.title : null,
        content: persistableContent(contentRef.current ?? target.content),
      });
    },
    [schedule],
  );

  // essay の title 編集のみ。kind の変更は遷移コマンド（setNoteKind）経由で seedNote される
  const onDraftChange = useCallback(
    (patch: DraftPatch) => {
      const current = noteRef.current;
      if (!current || patch.title === undefined || current.kind.kind !== "essay") return;
      const next: Note = { ...current, kind: { kind: "essay", title: patch.title } };
      noteRef.current = next;
      setNote(next);
      scheduleSave(next);
      const patchSummary = (s: NoteSummary) => (s.id === next.id ? { ...s, kind: next.kind } : s);
      setSummaries((list) => list?.map(patchSummary) ?? list);
      setProjectNotes((list) => list?.map(patchSummary) ?? list);
    },
    [scheduleSave],
  );

  // kind 遷移は backend が検証して確定形を返す。pending の content を先に flush して、
  // 遷移後に古い autosave が着弾する余地を潰す（title は CASE ガードで backend 側も防御済み）
  const applyKindTransition = useCallback(
    async (target: Parameters<typeof setNoteKind>[1]) => {
      const current = noteRef.current;
      if (!current) return;
      await flush();
      try {
        const updated = await setNoteKind(current.id, target);
        if (updated.kind.kind === "essay") pendingTitleFocusRef.current = true;
        seedNote(updated);
        setDataVersion((v) => v + 1);
      } catch {
        // 409/404 は UI 状態が古いだけ。dataVersion の再取得で追いつくので黙って握る
        setDataVersion((v) => v + 1);
      }
    },
    [flush, seedNote],
  );

  const toggleDailyEssay = useCallback(() => {
    const kind = noteRef.current?.kind.kind;
    if (kind !== "daily" && kind !== "essay") return; // project からの脱出経路なし
    void applyKindTransition({ kind: kind === "daily" ? "essay" : "daily" });
  }, [applyKindTransition]);

  const openPromotionPicker = useCallback(() => {
    // 昇格は daily → project のみ（essay は一度 daily に戻す）
    if (noteRef.current?.kind.kind !== "daily") return;
    openPicker("project");
  }, [openPicker]);

  const onDocChange = useCallback(
    (doc: unknown) => {
      contentRef.current = doc;
      const current = noteRef.current;
      if (current) scheduleSave(current);
    },
    [scheduleSave],
  );

  // note オブジェクトは編集のたびに identity が変わるので、リスナー再登録の deps には真偽だけ渡す
  const hasNote = note !== null;

  useEffect(() => {
    // capture phase で登録する: alt+delete 等はエディタ（ProseMirror の単語削除キーマップ）が
    // 先に食って window の bubble まで届かないため、エディタより先に横取りする必要がある
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      // ⌃T はトグル: filter picker 表示中は閉じ、filter 中は解除、通常時は picker を開く
      if (ctrlOnly && e.code === "KeyT" && (picker === null || picker === "filter")) {
        e.preventDefault();
        e.stopPropagation();
        if (picker === "filter") setPicker(null);
        else toggleProjectFilter();
        return;
      }
      if (ctrlOnly && picker === null && hasNote) {
        if (e.code === "KeyQ" || e.code === "KeyW") {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === "KeyQ") toggleDailyEssay();
          else openPromotionPicker();
          return;
        }
      }
      // picker 表示中のキー（^w クリア・↑↓・Enter 等）は picker 自身に任せる
      if (picker !== null) return;
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const act = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (e.code === "KeyN") {
        act(() => void createNew());
        return;
      }
      if (e.code === "Backspace" || e.code === "Delete") {
        act(() => {
          if (id !== null) void deleteById(id);
        });
        return;
      }
      if (e.code === "KeyZ") {
        act(() => void undoDelete());
        return;
      }
      if (e.code !== "KeyJ" && e.code !== "KeyK") return;
      act(() => {
        const ids = (displayedSummaries ?? []).map((s) => s.id);
        if (ids.length === 0) return;
        const step = e.code === "KeyJ" ? 1 : -1;
        const found = id === null ? -1 : ids.indexOf(id);
        // 未選択（または表示範囲外の id）は「リスト先頭の外側」扱い: J で先頭、K で末尾へ
        const idx = found === -1 ? (step === 1 ? -1 : 0) : found;
        selectNote(ids[(idx + step + ids.length) % ids.length]);
      });
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    displayedSummaries,
    id,
    hasNote,
    createNew,
    selectNote,
    deleteById,
    undoDelete,
    toggleDailyEssay,
    openPromotionPicker,
    toggleProjectFilter,
    picker,
  ]);

  return (
    <div
      className={`notes-screen relative flex h-dvh shrink-0 overflow-hidden ${
        resizing ? "cursor-col-resize select-none" : ""
      }`}
      style={{ "--sb-w": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside
        className={`w-[var(--sb-w)] shrink-0 overflow-hidden border-r group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0 ${
          resizing ? "" : "transition-[width] duration-200 motion-reduce:transition-none"
        }`}
      >
        {/* 開閉アニメーション中に中身が折り返さないよう幅は内側で固定する */}
        <div className="flex h-full w-[var(--sb-w)] flex-col">
          {listError && (
            <p className="px-4 pt-3 text-xs text-destructive">Failed to load notes — {listError}</p>
          )}
          {projectFilter === null ? (
            <>
              <NotesSidebar
                summaries={summaries}
                selectedId={id}
                range={range}
                today={today}
                onSelect={selectNote}
                onDelete={(summary) => void deleteById(summary.id)}
              />
              <NotesCalendar
                month={month}
                counts={counts}
                range={range}
                today={today}
                onMonthChange={(delta) => setMonth((m) => addMonths(m, delta))}
                onSelectWeek={(day) => setRange(weekOf(day))}
                onToday={resetToToday}
              />
            </>
          ) : (
            <ProjectNotesSidebar
              projectId={projectFilter}
              summaries={displayedSummaries}
              selectedId={id}
              today={today}
              query={sidebarQuery}
              onQueryChange={setSidebarQuery}
              hasMore={projectHasMore}
              onLoadMore={loadMoreProjectNotes}
              onSelect={selectNote}
              onDelete={(summary) => void deleteById(summary.id)}
              onClearFilter={clearProjectFilter}
            />
          )}
        </div>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={startResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        style={{ left: "var(--sb-w)" }}
        className="group/resize absolute inset-y-0 z-20 flex w-3 -translate-x-1/2 cursor-col-resize justify-center group-data-[zen]/shell:hidden"
      >
        <span
          className={`h-full w-0.5 transition-colors duration-100 ${
            resizing
              ? "bg-[var(--ink-muted)]"
              : "bg-transparent group-hover/resize:bg-[var(--ink-muted)]"
          }`}
        />
      </div>

      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {id === null ? (
          <EmptyState />
        ) : noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note ? (
          <div className="mx-auto w-full max-w-[960px] px-10">
            <EditorHeader
              note={note}
              titleRef={titleRef}
              saveError={saveError}
              onDraftChange={onDraftChange}
              onToggleEssay={toggleDailyEssay}
              onOpenProjectPicker={openPromotionPicker}
              onEnterEditor={focusEditorStart}
            />
            <BlockEditor
              key={note.id}
              initialDoc={note.content}
              autoFocus={!pendingTitleFocusRef.current}
              onDocChange={onDocChange}
              onExitUp={() => titleRef.current?.focus()}
              fetchLinkMetadata={fetchLinkMetadata}
              searchNoteMentions={searchNoteMentions}
              resolveNoteMention={resolveNoteMention}
              onNoteMentionClick={selectNote}
              noteId={note.id}
              resolveBlock={resolveBlock}
              onOpenBlock={onOpenBlock}
              uploadImage={uploadImageAsset}
              importExternalImage={importImageAsset}
              handleRef={editorHandleRef}
              className="min-h-[70dvh] pt-4 pb-24"
            />
          </div>
        ) : null}
      </main>

      {picker === "project" && note && (
        <FuzzyPickerModal
          items={projects.map((p) => ({ key: p.id, label: p.id }))}
          // 昇格は project_id 必須なので ^w clear（onSelect(null)）は無視する
          onSelect={(key) => {
            if (key === null) return;
            void applyKindTransition({ kind: "project", project_id: key });
          }}
          onClose={() => setPicker(null)}
          placeholder="Promote to project..."
          footer="↑↓ move · ⏎ promote · esc/^c close"
        />
      )}

      {picker === "filter" && (
        <FuzzyPickerModal
          items={projects.map((p) => ({ key: p.id, label: p.id }))}
          onSelect={(key) => {
            // project を選んだらフォーカスはサイドバーの検索欄（autoFocus）に渡す
            if (key !== null) pickerReturnFocusRef.current = null;
            setProjectFilter(key);
            setSidebarQuery("");
          }}
          onClose={() => setPicker(null)}
          placeholder="Filter by project..."
          footer="↑↓ move · ⏎ select · ^w clear · esc/^c close"
        />
      )}
    </div>
  );
}
