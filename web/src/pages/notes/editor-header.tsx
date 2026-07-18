import type { RefObject } from "react";
import type { Note, NoteKind } from "@/types.gen";
import { kindColor } from "./kind";

/** essay の title 編集だけが draft 経由。kind の変更は遷移コマンド（⌃Q / ⌃W）の担当 */
export type DraftPatch = { title?: string };

function KindChip({ kind, onToggle }: { kind: NoteKind; onToggle: () => void }) {
  // project は確定した分類なのでトグル不可（脱出経路なし）
  const inert = kind.kind === "project";
  return (
    <button
      type="button"
      onClick={inert ? undefined : onToggle}
      disabled={inert}
      title={inert ? "project note" : "Toggle daily / essay (⌃Q)"}
      className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-100 ${
        inert ? "cursor-default" : "hover:bg-[var(--ink-hover)]"
      }`}
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: kindColor(kind.kind) }}
      />
      <span className="text-[var(--ink-muted)]">{kind.kind}</span>
    </button>
  );
}

function ProjectChip({ kind, onOpenPicker }: { kind: NoteKind; onOpenPicker: () => void }) {
  if (kind.kind === "daily") {
    return (
      <button
        type="button"
        onClick={onOpenPicker}
        title="Promote to project (⌃W)"
        className="rounded-md px-1.5 py-0.5 text-[var(--ink-faint)] transition-colors duration-100 hover:bg-[var(--ink-hover)] hover:text-[var(--ink-muted)]"
      >
        + project
      </button>
    );
  }
  if (kind.kind === "project") {
    return (
      <span className="rounded-md px-1.5 py-0.5 font-mono text-[var(--ink-muted)]">
        {kind.project_id}
      </span>
    );
  }
  return null;
}

export function EditorHeader({
  note,
  titleRef,
  saveError,
  onDraftChange,
  onToggleEssay,
  onOpenProjectPicker,
  onEnterEditor,
}: {
  note: Note;
  titleRef: RefObject<HTMLInputElement | null>;
  saveError: string | null;
  onDraftChange: (patch: DraftPatch) => void;
  /** daily ↔ essay トグル（⌃Q 相当） */
  onToggleEssay: () => void;
  /** daily → project 昇格 picker（⌃W 相当） */
  onOpenProjectPicker: () => void;
  /** タイトルで Enter / ↓ が押されたとき（本文へのフォーカス移動） */
  onEnterEditor: () => void;
}) {
  return (
    <header className="pt-12">
      {note.kind.kind === "essay" && (
        <input
          ref={titleRef}
          value={note.kind.title}
          placeholder="Untitled"
          onChange={(e) => onDraftChange({ title: e.target.value })}
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
      )}
      <div className="mt-2.5 flex items-center gap-2 text-xs">
        <KindChip kind={note.kind} onToggle={onToggleEssay} />
        <ProjectChip kind={note.kind} onOpenPicker={onOpenProjectPicker} />
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
