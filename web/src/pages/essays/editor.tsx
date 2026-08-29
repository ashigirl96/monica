import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import { createEssay, deleteNote, setEssayStatus } from "@/api";
import { navigate } from "@/app";
import { altOnly, ctrlOnly } from "@/keys";
import type { EssayStatus, Note } from "@/types.gen";
import { takePendingBlockTarget } from "@/notes/block-jump";
import {
  cycleSelect,
  persistableContent,
  titleFieldKeyDown,
  useEditorDoc,
  useNoteBlockResolvers,
} from "@/notes/editor-support";
import { NoteBlockEditor } from "@/notes/note-block-editor";
import { useServerDoc } from "@/notes/note-sync";
import { NotesShell } from "@/notes/notes-shell";
import { useEssaysCache, useEssaysQuery, useNoteQuery, useSeedNote } from "@/notes/queries";
import { SaveStatus } from "@/notes/save-status";
import { useAutosave } from "@/notes/use-autosave";
import { EssaysSidebar } from "./sidebar";
import {
  dropEssay,
  otherEssayTab,
  patchEssayKind,
  pushDeletedEssay,
  restoreLastDeletedEssay,
  splitEssaysByStatus,
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
      title="Toggle writing / finished (⌃W)"
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
 * /essays/{id}: essay 専用エディタ。サイドバーは writing / finished のタブで片方だけを並べ、
 * ⌥H/⌥L で往復する。⌥K/J は表示中タブ内を巡回する。
 */
export function EssayEditorPage({ id }: { id: string }) {
  // サイドバーが表示中の status。⌥H/⌥L の手動切替と、開いた note の status への同期で動く
  const [tab, setTab] = useState<EssayStatus>("writing");
  const autosave = useAutosave();
  const { schedule, flush, discard, resume, error: saveError, conflictId } = autosave;
  const { setBase, hasUnsaved } = autosave;
  const { data: essays = null } = useEssaysQuery();
  const { patchEssays, invalidateEssays } = useEssaysCache();
  const seedNoteInCache = useSeedNote();
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

  const noteQuery = useNoteQuery(id);
  const { note, generation, reload, patchKind, adopt } = useServerDoc({
    docKey: id,
    data: noteQuery.data,
    autosave,
    contentRef,
    noteRef,
    refetch: noteQuery.refetch,
  });

  // 描画できる note がある間はエラーを出さない（daily と同じ理由 — 復帰時の一時的な
  // 再フェッチ失敗でエディタを unmount すると、保存済みの編集が巻き戻る）。
  const noteError = note === null && noteQuery.error !== null ? noteQuery.error.message : null;

  useEffect(() => {
    // 別 note の mention 解決結果を持ち越さない
    mentionCacheRef.current = new Map();
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

  // latch は docKey（= id）が変わった時点で捨てられるので、note は常に現 id のもの。
  // essay 以外を開いたときに旧 status でタブが動かないよう kind は見る
  const openStatus = note?.kind.kind === "essay" ? note.kind.status : null;

  useEffect(() => {
    // 「タブ == 開いている note の status」を恒常的に強制するのではなく、状態遷移として代入する
    // （常時強制だと ⌥H/⌥L した瞬間に mismatch と見なされて引き戻され、手動切替が成立しない）。
    // id も deps に要る: ⌥N は seedNote 済みなので openStatus が writing → writing で
    // 変わらないことがあり、そのとき id の変化だけが writing タブへの復帰を駆動する
    if (openStatus !== null) setTab(openStatus);
  }, [id, openStatus]);

  const groups = useMemo(() => splitEssaysByStatus(essays), [essays]);
  // ⌥K/J と削除後の送り先。表示中タブのリスト
  const cycleIds = useMemo(() => (groups?.[tab] ?? []).map((s) => s.id), [groups, tab]);

  const selectEssay = useCallback(
    (noteId: string) => {
      void flush();
      navigate(`/essays/${noteId}`);
    },
    [flush],
  );

  const patchSummaryKind = useCallback(
    (next: Note) => {
      patchEssays((list) => patchEssayKind(list, next.id, next.kind));
    },
    [patchEssays],
  );

  const scheduleSave = useCallback(
    (target: Note) => {
      schedule(target.id, {
        title: target.kind.kind === "essay" ? target.kind.title : null,
        content: persistableContent(contentRef.current ?? target.content),
      });
    },
    [schedule],
  );

  const createNew = useCallback(async () => {
    await flush();
    try {
      const created = await createEssay();
      pendingTitleFocusRef.current = true;
      // 先にキャッシュへ置いてから遷移する（loading を挟まず即描画される）
      seedNoteInCache(created);
      navigate(`/essays/${created.id}`);
      invalidateEssays();
    } catch {
      // 作成失敗は次の ⌥N で再試行できるので黙って握る
    }
  }, [flush, seedNoteInCache, invalidateEssays]);

  const deleteCurrent = useCallback(async () => {
    const target = noteRef.current;
    if (target === null) return;
    // 往復を待つ前に予約を締める。flush は pending を先に差し替えてから待つので、待っている
    // 間に schedule された分は成否に反映されず、直後の discard で消える。書き込み経路
    // （onDocChange / onTitleChange）は noteRef を見るので、外せば予約自体が起きない
    noteRef.current = null;
    // 締めている間に打った分は contentRef にあるので、中断するときは拾い直す
    const abort = () => {
      noteRef.current = target;
      scheduleSave(target);
    };
    // 保存が通っていない状態で消すと ⌥Z で戻せるのはサーバに届いた内容までになる。
    // flush は失敗しても resolve するので、成否を見て未保存分がある間は削除しない
    // （saveError が画面に出ているので、保存が回復すれば削除できる）
    if (!(await flush())) {
      abort();
      return;
    }
    try {
      await deleteNote(target.id);
    } catch {
      abort();
      return;
    }
    // 削除済み note への pending 保存を止める（再試行が 404 を叩き続けるのを防ぐ）
    discard(target.id);
    pushDeletedEssay(target.id);
    patchEssays((list) => dropEssay(list, target.id));
    // 表示中タブにあった note はサイドバーの次へ送って書く流れを切らない。タブ外の note は
    // 送り先が画面に見えていないので一覧へ帰す
    const next = cycleIds.includes(target.id) ? cycleSelect(cycleIds, target.id, 1) : undefined;
    if (next !== undefined && next !== target.id) navigate(`/essays/${next}`, { replace: true });
    else navigate("/essays", { replace: true });
  }, [flush, discard, scheduleSave, cycleIds, patchEssays]);

  const undoDelete = useCallback(async () => {
    const restored = await restoreLastDeletedEssay();
    if (restored === undefined) return;
    resume(restored.id);
    invalidateEssays();
    seedNoteInCache(restored);
    navigate(`/essays/${restored.id}`);
  }, [seedNoteInCache, resume, invalidateEssays]);

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
      // 失敗時の一覧再取得が編集前の preview に巻き戻らないように）。
      // 通らなかったときは中断する: 下で基準版を status の新しい updated_at へ進めてしまうと、
      // 競合で行き場を失った古い本文が「新しい基準版に載った正当な編集」に化け、次の打鍵で
      // 勝った側の外部変更を上書きしてしまう（削除と同じく、未保存が残る間は手を出さない）。
      if (!(await flush())) return;
      try {
        const updated = await setEssayStatus(current.id, current.kind.next_status);
        // status 列単独の UPDATE で updated_at だけが進む。自分の content 書き込みはその上に
        // 載せてよいので基準版は進める（進めないと自分のトグルで偽の 409 が出る）。
        setBase(updated.id, updated.updated_at);
        if (hasUnsaved(updated.id)) {
          // setEssayStatus の往復中に打鍵が入った。レスポンスの content はその打鍵より
          // 古いので、キャッシュにも latch にも載せない（新しい本文を失う）。
          // 新しい updated_at だけを古い content にスタンプするのも禁物 — キャッシュが
          // 嘘をつき、note 往復で 1 世代前の本文が mount される。kind だけ反映する。
          patchKind(updated.kind);
        } else {
          // 未保存が無ければレスポンスの content はサーバの真値。丸ごと採用してよい。
          seedNoteInCache(updated);
          adopt(updated, false);
        }
        patchSummaryKind(updated);
      } catch {
        // 409/404 は UI 状態が古いだけ。一覧の再取得で追いつくので黙って握る
        invalidateEssays();
      }
    };
    toggleChainRef.current = toggleChainRef.current.then(run);
  }, [
    flush,
    patchSummaryKind,
    invalidateEssays,
    setBase,
    hasUnsaved,
    patchKind,
    seedNoteInCache,
    adopt,
  ]);

  useEffect(() => {
    // capture phase で登録する: エディタ（ProseMirror）より先に横取りする必要がある
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (ctrlOnly(e) && e.code === "KeyW" && noteRef.current !== null) {
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
      // ⌥H/⌥L はサイドバーの見える範囲だけを変える。開いている note と URL は動かさない
      if (e.code === "KeyH" || e.code === "KeyL") {
        e.preventDefault();
        e.stopPropagation();
        setTab(otherEssayTab);
        return;
      }
      if (e.code !== "KeyJ" && e.code !== "KeyK") return;
      e.preventDefault();
      e.stopPropagation();
      // ⌥H/⌥L で反対タブに移っていると開いている note はリスト外扱いになる
      // （cycleSelect が先頭/末尾に入れる）
      const next = cycleSelect(cycleIds, id, e.code === "KeyJ" ? 1 : -1);
      if (next !== undefined) selectEssay(next);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cycleIds, id, selectEssay, createNew, toggleStatus, deleteCurrent, undoDelete]);

  const onTitleChange = useCallback(
    (title: string) => {
      const current = noteRef.current;
      if (current?.kind.kind !== "essay") return;
      const next: Note = { ...current, kind: { ...current.kind, title } };
      patchKind(next.kind);
      scheduleSave(next);
      patchSummaryKind(next);
    },
    [scheduleSave, patchSummaryKind, patchKind],
  );

  const { onDocChange, focusEditorStart } = useEditorDoc({
    contentRef,
    noteRef,
    editorHandleRef,
    scheduleSave,
  });

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
        ) : note !== null && note.kind.kind === "essay" ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
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
                <SaveStatus
                  saveError={saveError}
                  conflict={conflictId === note.id}
                  onReload={() => void reload()}
                />
              </div>
            </header>
            <NoteBlockEditor
              note={note}
              generation={generation}
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
