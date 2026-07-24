import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockEditor, type BlockEditorHandle } from "@shared/block-editor/block-editor";
import {
  createEssay,
  getNote,
  importImageAsset,
  listEssays,
  renderNoteMarkdown,
  setEssayStatus,
  uploadImageAsset,
} from "@/api";
import { navigate } from "@/app";
import type { Note, NoteSummary } from "@/types.gen";
import {
  fetchLinkMetadata,
  persistableContent,
  searchNoteMentions,
  useNoteBlockResolvers,
} from "../notes/editor-support";
import { useAutosave } from "../notes/use-autosave";
import { EssaysSidebar } from "./sidebar";
import "../notes/notes.css";

function StatusChip({
  status,
  onToggle,
}: {
  status: "writing" | "finished";
  onToggle: () => void;
}) {
  const writing = status === "writing";
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle writing / finished (⌃Q)"
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-100 hover:bg-[var(--ink-hover)]"
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: writing ? "var(--kind-essay)" : "var(--ink-faint)" }}
      />
      <span className="text-[var(--ink-muted)]">{status}</span>
    </button>
  );
}

/**
 * /essays/{id}: essay 専用エディタ。サイドバーは writing のみで、finished は
 * サイドバーに現れないが本文は開ける（一覧から開く）。
 */
export function EssayEditorPage({ id }: { id: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  // 全 essay（全 status）。サイドバー表示と ⌥K/J はここから writing だけを使う
  const [essays, setEssays] = useState<NoteSummary[] | null>(null);
  // 作成・status 変更の失敗後に一覧を再取得させるためのバージョン
  const [dataVersion, setDataVersion] = useState(0);
  const { schedule, flush, error: saveError } = useAutosave();
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // ⌥N 直後は本文ではなくタイトルへフォーカスする（ノート読み込み後の effect で消費）
  const pendingTitleFocusRef = useRef(false);
  const contentRef = useRef<unknown>(null);
  // onDocChange は BlockEditor の再レンダー前に発火し得るため、closure の note ではなく
  // 常に最新のフィールドを持つ ref から保存 payload を組み立てる
  const noteRef = useRef<Note | null>(null);

  // mention / synced block のジャンプ先は kind 横断のまま旧 /notes（Phase 3 で整理）
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
    listEssays()
      .then((list) => {
        if (!cancelled) setEssays(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  useEffect(() => {
    // ⌥N・⌃Q 直後は API レスポンスで seed 済みなので再フェッチしない
    if (noteRef.current?.id === id) return;
    mentionCacheRef.current = new Map();
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
        if (!cancelled) setNoteError(e instanceof Error ? e.message : "Failed to load essay");
      });
    return () => {
      cancelled = true;
    };
  }, [id, mentionCacheRef]);

  useEffect(() => {
    if (note && pendingTitleFocusRef.current) {
      pendingTitleFocusRef.current = false;
      titleRef.current?.focus();
    }
  }, [note]);

  const sidebarEssays = useMemo(
    () =>
      essays === null
        ? null
        : essays.filter((s) => s.kind.kind === "essay" && s.kind.status === "writing"),
    [essays],
  );
  const writingIds = useMemo(() => (sidebarEssays ?? []).map((s) => s.id), [sidebarEssays]);

  const selectEssay = useCallback(
    (noteId: string) => {
      void flush();
      navigate(`/essays/${noteId}`);
    },
    [flush],
  );

  // API レスポンスの note をそのまま表示状態にする（navigate 後の再フェッチを省く）
  const seedNote = useCallback((n: Note) => {
    contentRef.current = n.content;
    noteRef.current = n;
    setNote(n);
    setNoteError(null);
  }, []);

  const patchSummaryKind = useCallback((next: Note) => {
    setEssays(
      (list) => list?.map((s) => (s.id === next.id ? { ...s, kind: next.kind } : s)) ?? list,
    );
  }, []);

  const createNew = useCallback(async () => {
    await flush();
    try {
      const created = await createEssay();
      pendingTitleFocusRef.current = true;
      seedNote(created);
      navigate(`/essays/${created.id}`);
      setDataVersion((v) => v + 1);
    } catch {
      // 作成失敗は次の ⌥N で再試行できるので黙って握る
    }
  }, [flush, seedNote]);

  const toggleStatus = useCallback(async () => {
    const current = noteRef.current;
    if (current?.kind.kind !== "essay") return;
    // pending の content を先に flush する（title は status 列単独 UPDATE なので競合しないが、
    // 失敗時の一覧再取得が編集前の preview に巻き戻らないように）
    await flush();
    try {
      const next = current.kind.status === "writing" ? "finished" : "writing";
      const updated = await setEssayStatus(current.id, next);
      // エディタは開いたまま status チップとサイドバー（writing のみ）だけが変わる
      seedNote(updated);
      patchSummaryKind(updated);
    } catch {
      // 409/404 は UI 状態が古いだけ。一覧の再取得で追いつくので黙って握る
      setDataVersion((v) => v + 1);
    }
  }, [flush, seedNote, patchSummaryKind]);

  useEffect(() => {
    // capture phase で登録する: エディタ（ProseMirror）より先に横取りする必要がある
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (ctrlOnly && e.code === "KeyQ" && noteRef.current !== null) {
        e.preventDefault();
        e.stopPropagation();
        void toggleStatus();
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.code === "KeyN") {
        e.preventDefault();
        e.stopPropagation();
        void createNew();
        return;
      }
      if (e.code !== "KeyJ" && e.code !== "KeyK") return;
      e.preventDefault();
      e.stopPropagation();
      if (writingIds.length === 0) return;
      const step = e.code === "KeyJ" ? 1 : -1;
      const found = writingIds.indexOf(id);
      // リスト外（finished を開いている等）は「リスト先頭の外側」扱い: J で先頭、K で末尾へ
      const idx = found === -1 ? (step === 1 ? -1 : 0) : found;
      selectEssay(writingIds[(idx + step + writingIds.length) % writingIds.length]);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [writingIds, id, selectEssay, createNew, toggleStatus]);

  const scheduleSave = useCallback(
    (target: Note) => {
      schedule(target.id, {
        title: target.kind.kind === "essay" ? target.kind.title : null,
        content: persistableContent(contentRef.current ?? target.content),
      });
    },
    [schedule],
  );

  const onTitleChange = useCallback(
    (title: string) => {
      const current = noteRef.current;
      if (current?.kind.kind !== "essay") return;
      const next: Note = { ...current, kind: { ...current.kind, title } };
      noteRef.current = next;
      setNote(next);
      scheduleSave(next);
      patchSummaryKind(next);
    },
    [scheduleSave, patchSummaryKind],
  );

  const onDocChange = useCallback(
    (doc: unknown) => {
      contentRef.current = doc;
      const current = noteRef.current;
      if (current) scheduleSave(current);
    },
    [scheduleSave],
  );

  // タイトルからの移動は常に本文の先頭行へ
  const focusEditorStart = useCallback(() => {
    editorHandleRef.current?.focusStart();
  }, []);

  return (
    <div
      className="notes-screen relative flex h-dvh shrink-0 overflow-hidden"
      data-density="relaxed"
    >
      <aside className="w-[300px] shrink-0 overflow-hidden border-r transition-[width] duration-200 group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0 motion-reduce:transition-none">
        {/* 開閉アニメーション中に中身が折り返さないよう幅は内側で固定する */}
        <div className="h-full w-[300px]">
          <EssaysSidebar essays={sidebarEssays} selectedId={id} onSelect={selectEssay} />
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note !== null && note.kind.kind === "essay" ? (
          <div className="mx-auto w-full max-w-[760px] px-10">
            <header className="pt-12">
              <input
                ref={titleRef}
                value={note.kind.title}
                placeholder="Untitled"
                onChange={(e) => onTitleChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  const ctrlN = e.ctrlKey && !e.metaKey && !e.altKey && e.key === "n";
                  if (
                    e.key === "Enter" ||
                    e.key === "ArrowDown" ||
                    (e.key === "Tab" && !e.shiftKey) ||
                    ctrlN
                  ) {
                    e.preventDefault();
                    focusEditorStart();
                  }
                }}
                className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
              />
              <div className="mt-2.5 flex items-center gap-2 text-xs">
                <StatusChip status={note.kind.status} onToggle={() => void toggleStatus()} />
                <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
                  {note.date.replaceAll("-", ".")}
                </span>
                {saveError && (
                  <span className="text-destructive" title={saveError}>
                    Failed to save — changes retry on next edit
                  </span>
                )}
              </div>
            </header>
            <BlockEditor
              key={note.id}
              initialDoc={note.content}
              autoFocus={!pendingTitleFocusRef.current}
              onDocChange={onDocChange}
              onExitUp={() => titleRef.current?.focus()}
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
        ) : note !== null ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-faint)]">
            Not an essay — open it in Notes
          </div>
        ) : null}
      </main>
    </div>
  );
}
