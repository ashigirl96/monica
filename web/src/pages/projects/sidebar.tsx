import { useEffect, useRef } from "react";
import type { Note, NoteSummary } from "@/types.gen";
import { summaryTitle } from "@/notes/summary";

function TimelineItem({
  summary,
  selected,
  onSelect,
  onDelete,
}: {
  summary: NoteSummary;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group relative flex items-center rounded-md transition-colors duration-100 ${
        selected ? "bg-[var(--ink-hover)]" : "hover:bg-[var(--ink-hover)]"
      }`}
    >
      {selected && (
        <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--water)]" />
      )}
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-2.5 py-1.5 text-left">
        <span
          className={`block truncate text-[0.8rem] ${
            selected ? "text-[var(--ink-text)]" : "text-[var(--ink-muted)]"
          }`}
        >
          {summaryTitle(summary)}
        </span>
      </button>
      <button
        type="button"
        aria-label="Delete note"
        onClick={onDelete}
        className="mr-1 shrink-0 rounded p-1 text-[var(--ink-faint)] opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-[var(--ink-text)]"
      >
        <svg
          className="size-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * project サイドバー。最上段に primary note を固定（ラベル = project 名）し、その下に
 * 時系列で並ぶ通常 note を出す。primary は削除不可なので削除ボタンを出さない。
 */
export function ProjectsSidebar({
  projectName,
  primary,
  notes,
  selectedId,
  hasMore,
  onLoadMore,
  onSelectPrimary,
  onSelect,
  onDelete,
}: {
  projectName: string;
  primary: Note | null;
  notes: NoteSummary[] | null;
  selectedId: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelectPrimary: () => void;
  onSelect: (id: string) => void;
  onDelete: (summary: NoteSummary) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  const primarySelected = primary !== null && (selectedId === null || selectedId === primary.id);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4.5 pt-4 pb-1">
        <span className="font-mono text-[0.7rem] uppercase tracking-widest text-[var(--ink-muted)]">
          Project
        </span>
      </div>
      <div className="px-2 pt-1 pb-2">
        <button
          type="button"
          onClick={onSelectPrimary}
          disabled={primary === null}
          className={`relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 ${
            primarySelected ? "bg-[var(--ink-hover)]" : "hover:bg-[var(--ink-hover)]"
          }`}
        >
          {primarySelected && (
            <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--water)]" />
          )}
          <svg
            aria-hidden
            className="size-3 shrink-0 text-[var(--ink-faint)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 5h16l-6.5 7.5V19l-3-1.5v-5L4 5z"
            />
          </svg>
          <span
            className={`min-w-0 flex-1 truncate font-mono text-[0.78rem] ${
              primarySelected ? "text-[var(--ink-text)]" : "text-[var(--ink-muted)]"
            }`}
          >
            {projectName}
          </span>
        </button>
      </div>
      <div className="mx-4.5 border-t border-[var(--ink-border)]" />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {(notes ?? []).map((s) => (
          <TimelineItem
            key={s.id}
            summary={s}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
            onDelete={() => onDelete(s)}
          />
        ))}
        {notes !== null && notes.length === 0 && (
          <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">
            No notes yet — press ⌥N to add one
          </p>
        )}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="px-2.5 py-2 text-center text-[0.7rem] text-[var(--ink-faint)]"
          >
            …
          </div>
        )}
      </div>
    </div>
  );
}
