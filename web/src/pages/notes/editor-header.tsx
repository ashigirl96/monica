import type { RefObject } from "react";
import type { Note, NoteKind } from "@/types.gen";
import { kindColor } from "./kind";

/** essay の title 編集だけが draft 経由。kind の変更は遷移コマンド（⌃Q / ⌃W）の担当 */
export type DraftPatch = { title?: string };

/** relaxed = sizu 流のゆったりした縦リズム / compact = プロジェクトメモ向けの詰めた縦リズム */
export type NoteDensity = "relaxed" | "compact";

function DensityToggle({ density, onToggle }: { density: NoteDensity; onToggle: () => void }) {
  const compact = density === "compact";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={compact ? "Switch to relaxed spacing (⌥D)" : "Switch to compact spacing (⌥D)"}
      className="rounded-md p-1 text-[var(--ink-faint)] transition-colors duration-100 hover:bg-[var(--ink-hover)] hover:text-[var(--ink-muted)]"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        aria-hidden
      >
        {compact ? (
          <>
            <path d="M2 2.5h10" />
            <path d="M2 5.5h10" />
            <path d="M2 8.5h10" />
            <path d="M2 11.5h10" />
          </>
        ) : (
          <>
            <path d="M2 3h10" />
            <path d="M2 7h10" />
            <path d="M2 11h10" />
          </>
        )}
      </svg>
    </button>
  );
}

/** kind の表示のみ。kind 遷移は ⌃W の project 昇格だけが残っている（daily↔essay は撤去済み） */
function KindChip({ kind }: { kind: NoteKind }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: kindColor(kind.kind) }}
      />
      <span className="text-[var(--ink-muted)]">{kind.kind}</span>
    </span>
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
  density,
  onToggleDensity,
  onDraftChange,
  onOpenProjectPicker,
  onEnterEditor,
}: {
  note: Note;
  titleRef: RefObject<HTMLInputElement | null>;
  saveError: string | null;
  density: NoteDensity;
  onToggleDensity: () => void;
  onDraftChange: (patch: DraftPatch) => void;
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
          className="w-full bg-transparent text-[20px] font-normal tracking-[0.03em] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)]"
        />
      )}
      <div className="mt-2.5 flex items-center gap-2 text-xs">
        <KindChip kind={note.kind} />
        <ProjectChip kind={note.kind} onOpenPicker={onOpenProjectPicker} />
        <span className="ml-auto font-mono text-[0.7rem] text-[var(--ink-faint)]">
          {note.date.replaceAll("-", ".")}
        </span>
        <DensityToggle density={density} onToggle={onToggleDensity} />
        {saveError && (
          <span className="text-destructive" title={saveError}>
            Failed to save — changes retry on next edit
          </span>
        )}
      </div>
    </header>
  );
}
