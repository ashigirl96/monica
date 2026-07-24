import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import { createEssay, deleteNote, getNote, listEssays, setEssayStatus } from "@/api";
import { navigate } from "@/app";
import { altOnly, ctrlOnly } from "@/keys";
import type { Note, NoteSummary } from "@/types.gen";
import { takePendingBlockTarget } from "@/notes/block-jump";
import {
  cycleSelect,
  persistableContent,
  titleFieldKeyDown,
  useEditorDoc,
  useNoteBlockResolvers,
} from "@/notes/editor-support";
import { NoteBlockEditor } from "@/notes/note-block-editor";
import { NotesShell } from "@/notes/notes-shell";
import { useAutosave } from "@/notes/use-autosave";
import { EssaysSidebar } from "./sidebar";
import {
  dropEssay,
  essayStatus,
  patchEssayKind,
  pushDeletedEssay,
  restoreLastDeletedEssay,
} from "./support";

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
  const { schedule, flush, discard, error: saveError } = useAutosave();
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // ⌥N 直後は本文ではなくタイトルへフォーカスする（ノート読み込み後の effect で消費）
  const pendingTitleFocusRef = useRef(false);
  const contentRef = useRef<unknown>(null);
  // onDocChange は BlockEditor の再レンダー前に発火し得るため、closure の note ではなく
  // 常に最新のフィールドを持つ ref から保存 payload を組み立てる
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

  // synced block ジャンプの対象がロードされたらスクロールする。別 note からの cross-note
  // ジャンプは /notes/{id} リダイレクト経由でこのページに着地する
  useEffect(() => {
    if (!note) return;
    const blockId = takePendingBlockTarget(note.id);
    if (blockId) editorHandleRef.current?.scrollToBlock(blockId);
  }, [note]);

  const sidebarEssays = useMemo(
    () => (essays === null ? null : essays.filter((s) => essayStatus(s) === "writing")),
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
    setEssays((list) => patchEssayKind(list, next.id, next.kind));
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

  const deleteCurrent = useCallback(async () => {
    const target = noteRef.current;
    if (target === null) return;
    await flush();
    try {
      await deleteNote(target.id);
    } catch {
      // flush が失敗して pending が再試行待ちのまま DELETE も落ちた場合、ここで discard すると
      // 生きている note の未保存分を捨ててしまう。削除成功後にだけ pending を切る
      return;
    }
    // 削除済み note への pending 保存を止める（再試行が 404 を叩き続けるのを防ぐ）
    discard(target.id);
    pushDeletedEssay(target.id);
    setEssays((list) => dropEssay(list, target.id));
    // writing はサイドバーの次へ送って書く流れを切らない。finished（サイドバー外）は
    // 一覧から開いた note なので一覧へ帰す
    const next = writingIds.includes(target.id) ? cycleSelect(writingIds, target.id, 1) : undefined;
    if (next !== undefined && next !== target.id) navigate(`/essays/${next}`, { replace: true });
    else navigate("/essays", { replace: true });
  }, [flush, discard, writingIds]);

  const undoDelete = useCallback(async () => {
    const restored = await restoreLastDeletedEssay();
    if (restored === undefined) return;
    setDataVersion((v) => v + 1);
    seedNote(restored);
    navigate(`/essays/${restored.id}`);
  }, [seedNote]);

  // トグルを直列化する chain（use-autosave の flushChain と同じ手法）。連打時に両方が
  // 同じ status を読んで 2 回のトグルが 1 回に潰れるのを防ぎ、2 回目は 1 回目の結果に
  // rebase される（往復 = 元の status に戻る）。
  const toggleChainRef = useRef<Promise<void>>(Promise.resolve());

  const toggleStatus = useCallback(() => {
    // 押した瞬間の note が対象。chain の順番待ちの間に別 essay へ移動していたら不発
    const targetId = noteRef.current?.id;
    const run = async () => {
      const current = noteRef.current;
      if (current === null || current.id !== targetId || current.kind.kind !== "essay") return;
      // pending の content を先に flush する（title は status 列単独 UPDATE なので競合しないが、
      // 失敗時の一覧再取得が編集前の preview に巻き戻らないように）
      await flush();
      try {
        const updated = await setEssayStatus(current.id, current.kind.next_status);
        // エディタは開いたまま status チップとサイドバー（writing のみ）だけが変わる。
        // content は seed しない — 直前の flush が失敗して pending が再試行待ちのとき、
        // status-only レスポンスの古い content で contentRef を巻き戻すと、後続の title 編集が
        // その古い本文で pending を上書きして編集を失うため（kind と updated_at だけ反映する）
        const merged: Note = { ...current, kind: updated.kind, updated_at: updated.updated_at };
        noteRef.current = merged;
        setNote(merged);
        patchSummaryKind(merged);
      } catch {
        // 409/404 は UI 状態が古いだけ。一覧の再取得で追いつくので黙って握る
        setDataVersion((v) => v + 1);
      }
    };
    toggleChainRef.current = toggleChainRef.current.then(run);
  }, [flush, patchSummaryKind]);

  useEffect(() => {
    // capture phase で登録する: エディタ（ProseMirror）より先に横取りする必要がある
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (ctrlOnly(e) && e.code === "KeyQ" && noteRef.current !== null) {
        e.preventDefault();
        e.stopPropagation();
        toggleStatus();
        return;
      }
      if (!altOnly(e)) return;
      if (e.code === "KeyN") {
        e.preventDefault();
        e.stopPropagation();
        void createNew();
        return;
      }
      if (e.code === "Backspace" || e.code === "Delete") {
        if (noteRef.current === null) return;
        e.preventDefault();
        e.stopPropagation();
        void deleteCurrent();
        return;
      }
      if (e.code === "KeyZ") {
        e.preventDefault();
        e.stopPropagation();
        void undoDelete();
        return;
      }
      if (e.code !== "KeyJ" && e.code !== "KeyK") return;
      e.preventDefault();
      e.stopPropagation();
      // finished を開いているときはリスト外扱い（cycleSelect が先頭/末尾に入れる）
      const next = cycleSelect(writingIds, id, e.code === "KeyJ" ? 1 : -1);
      if (next !== undefined) selectEssay(next);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [writingIds, id, selectEssay, createNew, toggleStatus, deleteCurrent, undoDelete]);

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

  const { onDocChange, focusEditorStart } = useEditorDoc({
    contentRef,
    noteRef,
    editorHandleRef,
    scheduleSave,
  });

  return (
    <NotesShell
      sidebar={<EssaysSidebar essays={sidebarEssays} selectedId={id} onSelect={selectEssay} />}
    >
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
                onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
              />
              <div className="mt-2.5 flex items-center gap-2 text-xs">
                <StatusChip status={note.kind.status} onToggle={toggleStatus} />
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
            <NoteBlockEditor
              note={note}
              autoFocus={!pendingTitleFocusRef.current}
              onDocChange={onDocChange}
              onExitUp={() => titleRef.current?.focus()}
              onNoteMentionClick={openInNotes}
              resolveNoteMention={resolveNoteMention}
              resolveBlock={resolveBlock}
              onOpenBlock={onOpenBlock}
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
  );
}
