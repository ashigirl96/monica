import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import {
  createProjectNote,
  deleteNote,
  getNote,
  listProjectNotes,
  listProjects,
  primaryNote,
  restoreNote,
} from "@/api";
import { navigate } from "@/app";
import type { Note, NoteSummary, ProjectOption } from "@/types.gen";
import { takePendingBlockTarget } from "@/notes/block-jump";
import {
  cycleSelect,
  persistableContent,
  titleFieldKeyDown,
  useEditorDoc,
  useNoteBlockResolvers,
} from "@/notes/editor-support";
import { NoteBlockEditor } from "@/notes/note-block-editor";
import { useAutosave } from "@/notes/use-autosave";
import { FuzzyPickerModal } from "@/components/fuzzy-picker-modal";
import { ProjectsSidebar } from "./sidebar";
import { setLastProject } from "./support";
import "@/notes/notes.css";

function projectPath(projectId: string, noteId?: string): string {
  return noteId ? `/projects/${projectId}/notes/${noteId}` : `/projects/${projectId}`;
}

/**
 * /projects/{project_id}[/notes/{note_id}]: project エディタ。noteId 無し = primary note。
 * サイドバーは primary 固定 + 時系列。⌃W で project 切替、⌥N で新規 note。
 */
export function ProjectEditor({ projectId, noteId }: { projectId: string; noteId: string | null }) {
  const [note, setNote] = useState<Note | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [primary, setPrimary] = useState<Note | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  // primary を含む全 project note の生リスト（pagination offset の基準）。表示用の時系列は
  // ここから primary を除いたもの。
  const [rawNotes, setRawNotes] = useState<NoteSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { schedule, flush, discard, error: saveError } = useAutosave();
  const editorHandleRef = useRef<BlockEditorHandle | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingTitleFocusRef = useRef(false);
  const contentRef = useRef<unknown>(null);
  const noteRef = useRef<Note | null>(null);
  const primaryIdRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const undoStackRef = useRef<string[]>([]);

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

  // project 一覧（⌃W picker とヘッダ名の表示用）。切替時に project 名がすぐ出るよう一度だけ取る
  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // project が確定したら primary を get-or-create し、時系列 1 ページ目を取る
  useEffect(() => {
    let cancelled = false;
    setPrimary(null);
    primaryIdRef.current = null;
    setRawNotes(null);
    setProjectError(null);
    undoStackRef.current = [];
    setLastProject(projectId);
    primaryNote(projectId)
      .then((p) => {
        if (cancelled) return;
        primaryIdRef.current = p.id;
        setPrimary(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setProjectError(e instanceof Error ? e.message : "Failed to open project");
      });
    listProjectNotes(projectId, 0)
      .then((page) => {
        if (cancelled) return;
        setRawNotes(page.items);
        setHasMore(page.has_more);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, dataVersion]);

  // 表示する note の解決。noteId 無し = primary、primary の id を指していたら URL を正規化する
  useEffect(() => {
    if (noteId === null) {
      if (primary) {
        contentRef.current = primary.content;
        noteRef.current = primary;
        setNote(primary);
        setNoteError(null);
      }
      return;
    }
    if (primaryIdRef.current !== null && noteId === primaryIdRef.current) {
      navigate(projectPath(projectId), { replace: true });
      return;
    }
    // ⌥N 直後は seed 済みなので再フェッチしない
    if (noteRef.current?.id === noteId) return;
    mentionCacheRef.current = new Map();
    let cancelled = false;
    noteRef.current = null;
    setNote(null);
    setNoteError(null);
    getNote(noteId)
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
  }, [noteId, projectId, primary, mentionCacheRef]);

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

  const seedNote = useCallback((n: Note) => {
    contentRef.current = n.content;
    noteRef.current = n;
    setNote(n);
    setNoteError(null);
  }, []);

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
      seedNote(created);
      navigate(projectPath(projectId, created.id));
      setDataVersion((v) => v + 1);
    } catch {
      // 作成失敗は次の ⌥N で再試行できるので黙って握る
    }
  }, [flush, projectId, seedNote]);

  const loadMore = useCallback(async () => {
    if (rawNotes === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const page = await listProjectNotes(projectId, rawNotes.length);
      setRawNotes((prev) => {
        const seen = new Set((prev ?? []).map((s) => s.id));
        return [...(prev ?? []), ...page.items.filter((s) => !seen.has(s.id))];
      });
      setHasMore(page.has_more);
    } catch {
      // 失敗は次に sentinel が見えたときに再試行される
    } finally {
      loadingMoreRef.current = false;
    }
  }, [projectId, rawNotes]);

  const deleteById = useCallback(
    async (targetId: string) => {
      // primary は削除不可
      if (targetId === primaryIdRef.current) return;
      await flush();
      discard(targetId);
      try {
        await deleteNote(targetId);
      } catch {
        return;
      }
      undoStackRef.current.push(targetId);
      setRawNotes((list) => list?.filter((s) => s.id !== targetId) ?? list);
      if (noteId === targetId) navigate(projectPath(projectId), { replace: true });
    },
    [flush, discard, noteId, projectId],
  );

  const undoDelete = useCallback(async () => {
    const targetId = undoStackRef.current.pop();
    if (!targetId) return;
    let restored: Note;
    try {
      restored = await restoreNote(targetId);
    } catch {
      return;
    }
    setDataVersion((v) => v + 1);
    seedNote(restored);
    navigate(projectPath(projectId, targetId));
  }, [seedNote, projectId]);

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
      const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (ctrlOnly && e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        setPickerOpen(true);
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
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

  const scheduleSave = useCallback(
    (target: Note) => {
      // primary は title を編集しないので title は送らない（project 名で表示する）
      const editableTitle =
        target.id !== primaryIdRef.current && target.kind.kind === "project"
          ? target.kind.title
          : null;
      schedule(target.id, {
        title: editableTitle,
        content: persistableContent(contentRef.current ?? target.content),
      });
    },
    [schedule],
  );

  const patchSummaryKind = useCallback((next: Note) => {
    setRawNotes(
      (list) => list?.map((s) => (s.id === next.id ? { ...s, kind: next.kind } : s)) ?? list,
    );
  }, []);

  const onTitleChange = useCallback(
    (title: string) => {
      const current = noteRef.current;
      if (current?.kind.kind !== "project") return;
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

  const pickerItems = useMemo(
    () => projects.map((p) => ({ key: p.id, label: p.name !== "" ? p.name : p.id })),
    [projects],
  );

  return (
    <div
      className="notes-screen relative flex h-dvh shrink-0 overflow-hidden"
      data-density="relaxed"
    >
      <aside className="w-[300px] shrink-0 overflow-hidden border-r transition-[width] duration-200 group-data-[zen]/shell:w-0 group-data-[zen]/shell:border-r-0 motion-reduce:transition-none">
        <div className="h-full w-[300px]">
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
        </div>
      </aside>

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
          <div className="mx-auto w-full max-w-[760px] px-10">
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
    </div>
  );
}
