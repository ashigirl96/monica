import type { RefObject } from "react";
import type { Note, NoteKind, UpdateNote } from "@/types.gen";
import { kindColor } from "./kind";

export type DraftPatch = Partial<Pick<UpdateNote, "title" | "kind" | "project_id">>;

function KindChip({ kind, onOpenPicker }: { kind: NoteKind; onOpenPicker: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpenPicker}
      title="Kind (⌃Q)"
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-100 hover:bg-[var(--ink-hover)]"
    >
      <span aria-hidden className="size-2 rounded-full" style={{ background: kindColor(kind) }} />
      <span className="text-[var(--ink-muted)]">{kind}</span>
    </button>
  );
}

function ProjectChip({
  projectId,
  onOpenPicker,
  onClear,
}: {
  projectId: string | null;
  onOpenPicker: () => void;
  onClear: () => void;
}) {
  if (projectId === null) {
    return (
      <button
        type="button"
        onClick={onOpenPicker}
        title="Project (⌃W)"
        className="rounded-md px-1.5 py-0.5 text-[var(--ink-faint)] transition-colors duration-100 hover:bg-[var(--ink-hover)] hover:text-[var(--ink-muted)]"
      >
        + project
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[var(--ink-muted)]">
      <button
        type="button"
        onClick={onOpenPicker}
        title="Project (⌃W)"
        className="transition-colors duration-100 hover:text-[var(--ink-text)]"
      >
        {projectId}
      </button>
      <button
        type="button"
        aria-label="Remove project"
        onClick={onClear}
        className="text-[var(--ink-faint)] transition-colors duration-100 hover:text-[var(--ink-muted)]"
      >
        <svg
          className="size-2.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

export function EditorHeader({
  note,
  titleRef,
  saveError,
  onDraftChange,
  onOpenKindPicker,
  onOpenProjectPicker,
  onEnterEditor,
}: {
  note: Note;
  titleRef: RefObject<HTMLInputElement | null>;
  saveError: string | null;
  onDraftChange: (patch: DraftPatch) => void;
  onOpenKindPicker: () => void;
  onOpenProjectPicker: () => void;
  /** タイトルで Enter / ↓ が押されたとき（本文へのフォーカス移動） */
  onEnterEditor: () => void;
}) {
  return (
    <header className="pt-12">
      <input
        ref={titleRef}
        value={note.title ?? ""}
        placeholder="Untitled"
        onChange={(e) => onDraftChange({ title: e.target.value === "" ? null : e.target.value })}
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
            onEnterEditor();
          }
        }}
        className="w-full bg-transparent text-3xl font-semibold text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
      />
      <div className="mt-2.5 flex items-center gap-2 text-xs">
        <KindChip kind={note.kind} onOpenPicker={onOpenKindPicker} />
        <ProjectChip
          projectId={note.project_id}
          onOpenPicker={onOpenProjectPicker}
          onClear={() => onDraftChange({ project_id: null })}
        />
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
  );
}
