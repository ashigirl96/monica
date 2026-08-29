import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import { createProjectNote, deleteNote, restoreNote } from "@/api";
import { navigate } from "@/app";
import { altOnly, ctrlOnly } from "@/keys";
import type { Note } from "@/types.gen";
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
import {
  useNoteQuery,
  useProjectNotesCache,
  useProjectNotesQuery,
  useProjectPrimaryQuery,
  useProjectsQuery,
  useSeedNote,
} from "@/notes/queries";
import { SaveStatus } from "@/notes/save-status";
import { useAutosaveContext } from "@/notes/autosave-context";
import { noteLabel } from "@/notes/summary";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";
import { ProjectsSidebar } from "./sidebar";
import { setLastProject } from "./support";

function projectPath(projectId: string, noteId?: string): string {
  return noteId ? `/projects/${projectId}/notes/${noteId}` : `/projects/${projectId}`;
}

/**
 * /projects/{project_id}[/notes/{note_id}]: project エディタ。noteId 無し = primary note。
 * サイドバーは primary 固定 + 時系列。⌃W で project 切替、⌥N で新規 note。
 */
export function ProjectEditor({ projectId, noteId }: { projectId: string; noteId: string | null }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const autosave = useAutosaveContext();
  const { schedule, flush, discard, resume } = autosave;
  const { hasUnsaved } = autosave;
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingTitleFocusRef = useRef(false);
  const contentRef = useRef<unknown>(null);
  const noteRef = useRef<Note | null>(null);
  const primaryIdRef = useRef<string | null>(null);
  const undoStackRef = useRef<string[]>([]);

  const { data: projects = [] } = useProjectsQuery();
  const primaryQuery = useProjectPrimaryQuery(projectId);
  const primary = primaryQuery.data ?? null;
  const notesQuery = useProjectNotesQuery(projectId);
  const { patchProjectNotes, invalidateProject } = useProjectNotesCache(projectId);
  const seedNoteInCache = useSeedNote();
  // primary を含む全 project note の生リスト（pagination offset の基準）。表示用の時系列は
  // ここから primary を除いたもの。
  const rawNotes = useMemo(
    () => notesQuery.data?.pages.flatMap((p) => p.items) ?? null,
    [notesQuery.data],
  );
  const hasMore = notesQuery.hasNextPage;

  useEffect(() => {
    primaryIdRef.current = primary?.id ?? null;
  }, [primary]);

  useEffect(() => {
    setLastProject(projectId);
  }, [projectId]);

  const projectName = useMemo(() => {
    const found = projects.find((p) => p.id === projectId);
    return found && found.name !== "" ? found.name : projectId;
  }, [projects, projectId]);

  const timeline = useMemo(
    () => (rawNotes === null ? null : rawNotes.filter((s) => s.id !== primaryIdRef.current)),
    // primaryIdRef を state 化しない代わりに primary の変化で再計算する
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawNotes, primary],
  );

  // mention / synced block のジャンプ先は kind に応じたリダイレクトが受ける（NoteRedirect）
  const openInNotes = useCallback(
    (targetId: string) => {
      void flush();
      navigate(`/notes/${targetId}`);
    },
    [flush],
  );

  const { mentionCacheRef, resolveNoteMention, resolveBlock, onOpenBlock } = useNoteBlockResolvers({
    flush,
    noteRef,
    editorHandleRef,
    onNavigateToNote: openInNotes,
  });

  // primary の id を指す URL は正規化する（/projects/{id} が primary の正準形）
  useEffect(() => {
    if (noteId !== null && primaryIdRef.current !== null && noteId === primaryIdRef.current) {
      navigate(projectPath(projectId), { replace: true });
    }
  }, [noteId, projectId, primary]);

  // 表示する doc は noteId 無し = primary、あり = その note。latch のキーも同じ軸で切る
  const noteQuery = useNoteQuery(noteId);
  const docKey = noteId ?? projectId;
  const { note, generation, reload, patchKind } = useServerDoc({
    docKey,
    data: noteId === null ? primaryQuery.data : noteQuery.data,
    autosave,
    contentRef,
    noteRef,
    refetch: noteId === null ? primaryQuery.refetch : noteQuery.refetch,
  });

  // 描画できる note がある間はエラーを出さない（daily と同じ理由 — 復帰時の一時的な
  // 再フェッチ失敗でエディタを unmount すると、保存済みの編集が巻き戻る）。
  const noteError = note === null && noteQuery.error !== null ? noteQuery.error.message : null;

  // primary の取得失敗も、描画できる note がある間は出さない（noteError と同じ理由）
  const projectError =
    note === null && primaryQuery.error !== null ? primaryQuery.error.message : null;

  useEffect(() => {
    // 別 note の mention 解決結果を持ち越さない
    mentionCacheRef.current = new Map();
  }, [docKey, mentionCacheRef]);

  useEffect(() => {
    undoStackRef.current = [];
  }, [projectId]);

  useEffect(() => {
    if (note && pendingTitleFocusRef.current) {
      pendingTitleFocusRef.current = false;
      titleRef.current?.focus();
    }
  }, [note]);

  // synced block ジャンプの対象がロードされたらスクロールする
  useEffect(() => {
    if (!note) return;
    const blockId = takePendingBlockTarget(note.id);
    if (blockId) editorHandleRef.current?.scrollToBlock(blockId);
  }, [note]);

  const isPrimary = note !== null && note.id === primaryIdRef.current;

  // ⌥K/J の巡回対象: primary（先頭）＋時系列
  const cycleIds = useMemo(
    () => (primary ? [primary.id, ...(timeline ?? []).map((s) => s.id)] : []),
    [primary, timeline],
  );
  const currentId = noteId ?? primaryIdRef.current;

  const selectNote = useCallback(
    (targetId: string) => {
      void flush();
      if (targetId === primaryIdRef.current) navigate(projectPath(projectId));
      else navigate(projectPath(projectId, targetId));
    },
    [flush, projectId],
  );

  const createNew = useCallback(async () => {
    await flush();
    try {
      const created = await createProjectNote(projectId);
      pendingTitleFocusRef.current = true;
      // 先にキャッシュへ置いてから遷移する（loading を挟まず即描画される）
      seedNoteInCache(created);
      navigate(projectPath(projectId, created.id));
      invalidateProject();
    } catch {
      // 作成失敗は次の ⌥N で再試行できるので黙って握る
    }
  }, [flush, projectId, seedNoteInCache, invalidateProject]);

  const loadMore = useCallback(() => {
    // 多重発火は infinite query 側が弾く。失敗は次に sentinel が見えたときに再試行される
    void notesQuery.fetchNextPage();
  }, [notesQuery]);

  const scheduleSave = useCallback(
    (target: Note) => {
      // primary は title を編集しないので title は送らない（project 名で表示する）
      const editableTitle =
        target.id !== primaryIdRef.current && target.kind.kind === "project"
          ? target.kind.title
          : null;
      // 競合通知の見出しもヘッダと同じ規則で決める（primary は project 名で名指しする）
      const label =
        target.id === primaryIdRef.current ? projectName : noteLabel(target, "Untitled");
      schedule(
        target.id,
        {
          title: editableTitle,
          content: persistableContent(contentRef.current ?? target.content),
        },
        label,
      );
    },
    [schedule, projectName],
  );

  const deleteById = useCallback(
    async (targetId: string) => {
      // primary は削除不可
      if (targetId === primaryIdRef.current) return;
      // 開いている note を消す場合は、往復を待つ前に予約を締める。flush は pending を先に
      // 差し替えてから待つので、待っている間に schedule された分は成否に反映されず、直後の
      // discard で消える。書き込み経路は noteRef を見るので、外せば予約自体が起きない
      const editing = noteRef.current?.id === targetId ? noteRef.current : null;
      if (editing !== null) noteRef.current = null;
      // 締めている間に打った分は contentRef にあるので、中断するときは拾い直す
      const abort = () => {
        if (editing === null) return;
        noteRef.current = editing;
        scheduleSave(editing);
      };
      // この note の未保存分が残る間は削除しない（⌥Z で戻せるのがサーバに届いた内容までになる）
      await flush();
      if (hasUnsaved(targetId)) {
        abort();
        return;
      }
      try {
        await deleteNote(targetId);
      } catch {
        abort();
        return;
      }
      // 削除済み note への pending 保存を止める（再試行が 404 を叩き続けるのを防ぐ）
      discard(targetId);
      undoStackRef.current.push(targetId);
      patchProjectNotes((items) => items.filter((s) => s.id !== targetId));
      if (noteId === targetId) navigate(projectPath(projectId), { replace: true });
    },
    [flush, discard, scheduleSave, noteId, projectId, patchProjectNotes, hasUnsaved],
  );

  const undoDelete = useCallback(async () => {
    const targetId = undoStackRef.current.pop();
    if (!targetId) return;
    let restored: Note;
    try {
      restored = await restoreNote(targetId);
    } catch {
      // 失敗のたびに id を捨てると ⌥Z が二度と効かなくなるので戻す
      undoStackRef.current.push(targetId);
      return;
    }
    resume(targetId);
    invalidateProject();
    seedNoteInCache(restored);
    navigate(projectPath(projectId, targetId));
  }, [seedNoteInCache, projectId, resume, invalidateProject]);

  const switchProject = useCallback(
    (nextId: string) => {
      if (nextId === projectId) return;
      void flush();
      setLastProject(nextId);
      navigate(projectPath(nextId));
    },
    [flush, projectId],
  );

  useEffect(() => {
    // capture phase: ProseMirror より先に横取りする
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (ctrlOnly(e) && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        setPickerOpen(true);
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
        const target = noteRef.current;
        if (target && target.id !== primaryIdRef.current) {
          e.preventDefault();
          e.stopPropagation();
          void deleteById(target.id);
        }
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
      const next = cycleSelect(cycleIds, currentId, e.code === "KeyJ" ? 1 : -1);
      if (next !== undefined) selectNote(next);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cycleIds, currentId, selectNote, createNew, deleteById, undoDelete]);

  const patchSummaryKind = useCallback(
    (next: Note) => {
      patchProjectNotes((items) =>
        items.map((s) => (s.id === next.id ? { ...s, kind: next.kind } : s)),
      );
    },
    [patchProjectNotes],
  );

  const onTitleChange = useCallback(
    (title: string) => {
      const current = noteRef.current;
      if (current?.kind.kind !== "project") return;
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

  const pickerItems = useMemo(
    () => projects.map((p) => ({ key: p.id, label: p.name !== "" ? p.name : p.id })),
    [projects],
  );

  return (
    <NotesShell
      sidebar={
        <ProjectsSidebar
          projectName={projectName}
          primary={primary}
          notes={timeline}
          selectedId={currentId}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onSelectPrimary={() => selectNote(primaryIdRef.current ?? "")}
          onSelect={selectNote}
          onDelete={(s) => void deleteById(s.id)}
        />
      }
    >
      <main className="flex-1 overflow-y-auto bg-[var(--paper)]">
        {projectError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {projectError}
          </div>
        ) : noteError ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {noteError}
          </div>
        ) : note !== null ? (
          <div className="mx-auto w-full max-w-[calc(760px+var(--note-extra-w,0px))] px-10">
            <header className="pt-12">
              {isPrimary ? (
                <h1 className="text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)]">
                  {projectName}
                </h1>
              ) : (
                <input
                  ref={titleRef}
                  value={note.kind.kind === "project" ? note.kind.title : ""}
                  placeholder="Untitled"
                  onChange={(e) => onTitleChange(e.target.value)}
                  onKeyDown={(e) => titleFieldKeyDown(e, focusEditorStart)}
                  className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
                />
              )}
              <div className="mt-2.5 flex items-center gap-2 text-xs">
                <span className="font-mono text-[0.7rem] uppercase tracking-widest text-[var(--ink-faint)]">
                  {isPrimary ? "primary" : "note"}
                </span>
                <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
                  {note.date.replaceAll("-", ".")}
                </span>
                <SaveStatus noteId={note.id} onReload={() => void reload()} />
              </div>
            </header>
            <NoteBlockEditor
              note={note}
              generation={generation}
              autoFocus={!pendingTitleFocusRef.current}
              onDocChange={onDocChange}
              onExitUp={isPrimary ? undefined : () => titleRef.current?.focus()}
              onNoteMentionClick={openInNotes}
              resolveNoteMention={resolveNoteMention}
              resolveBlock={resolveBlock}
              onOpenBlock={onOpenBlock}
              handleRef={editorHandleRef}
            />
          </div>
        ) : null}
      </main>

      {pickerOpen && (
        <FuzzyPickerModal
          items={pickerItems}
          placeholder="Switch project…"
          onSelect={(key) => {
            if (key !== null) switchProject(key);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </NotesShell>
  );
}
