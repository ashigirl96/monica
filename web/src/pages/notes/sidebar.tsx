import { useEffect, useRef } from "react";
import type { NoteSummary } from "@/types.gen";
import type { DateRange } from "./dates";
import { addDays, dayLabel, dayLabelWithYear, formatTime, todayKey } from "./dates";
import { kindColor } from "./kind";

export function summaryTitle(summary: NoteSummary): string {
  return summary.title ?? summary.preview ?? "Untitled";
}

function NoteItem({
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
        <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--ink-muted)]" />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: kindColor(summary.kind) }}
          title={summary.kind}
        />
        <span
          className={`min-w-0 flex-1 truncate text-[0.8rem] ${
            summary.title === null && summary.preview === null
              ? "text-[var(--ink-faint)]"
              : selected
                ? "text-[var(--ink-text)]"
                : "text-[var(--ink-muted)]"
          }`}
        >
          {summaryTitle(summary)}
        </span>
        <time
          dateTime={summary.created_at}
          className="shrink-0 font-mono text-[0.6rem] text-[var(--ink-faint)] group-hover:opacity-0"
        >
          {formatTime(summary.created_at)}
        </time>
      </button>
      <button
        type="button"
        aria-label="Delete note"
        title="Delete note"
        onClick={onDelete}
        className="absolute right-1.5 rounded p-1 text-[var(--ink-faint)] opacity-0 transition-opacity duration-100 hover:bg-[var(--ink-hover)] hover:text-destructive group-hover:opacity-100"
      >
        <svg
          className="size-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 7h12M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7m-6 3.5v7m3-7v7m3-10.5l-.7 11.2a2 2 0 01-2 1.8h-3.6a2 2 0 01-2-1.8L6 7"
          />
        </svg>
      </button>
    </div>
  );
}

function DayHeading({ day }: { day: string }) {
  return (
    <h2 className="px-2.5 pb-1 font-mono text-[0.65rem] uppercase tracking-widest text-[var(--ink-faint)]">
      {day === todayKey() ? `TODAY · ${dayLabel(day)}` : dayLabelWithYear(day)}
    </h2>
  );
}

/** project filter モードのサイドバー。summaries は fuzzy 絞り込み済みの表示リストを受け取る */
export function ProjectNotesSidebar({
  projectId,
  summaries,
  selectedId,
  query,
  onQueryChange,
  hasMore,
  onLoadMore,
  onSelect,
  onDelete,
  onClearFilter,
}: {
  projectId: string;
  summaries: NoteSummary[] | null;
  selectedId: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelect: (id: string) => void;
  onDelete: (summary: NoteSummary) => void;
  onClearFilter: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // sentinel がリスト末尾で見えている間はページを足す。fuzzy 絞り込みでリストが縮んでいる
  // ときも sentinel が見え続けるので、一致が増えるまで自動でロード範囲が広がる。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  const groups: { day: string; notes: NoteSummary[] }[] = [];
  for (const summary of summaries ?? []) {
    const last = groups[groups.length - 1];
    if (last && last.day === summary.date) {
      last.notes.push(summary);
    } else {
      groups.push({ day: summary.date, notes: [summary] });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pt-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-md bg-[var(--ink-hover)] px-2.5 py-1.5">
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
          <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-[var(--ink-text)]">
            {projectId}
          </span>
          <button
            type="button"
            aria-label="Clear project filter"
            title="Clear project filter (⌃T)"
            onClick={onClearFilter}
            className="shrink-0 rounded p-0.5 text-[var(--ink-faint)] transition-colors duration-100 hover:text-[var(--ink-text)]"
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
        </div>
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              if (query === "") e.currentTarget.blur();
              else onQueryChange("");
              return;
            }
            if (e.key === "Enter" && summaries?.length) {
              onSelect(summaries[0].id);
            }
          }}
          placeholder="Search titles…"
          autoFocus
          className="mt-2 w-full border-b border-[var(--ink-border)] bg-transparent px-1 pb-1 text-[0.8rem] text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--ink-muted)]"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map(({ day, notes }) => (
          <section key={day} className="mb-3">
            <DayHeading day={day} />
            {notes.map((summary) => (
              <NoteItem
                key={summary.id}
                summary={summary}
                selected={summary.id === selectedId}
                onSelect={() => onSelect(summary.id)}
                onDelete={() => onDelete(summary)}
              />
            ))}
          </section>
        ))}
        {summaries !== null && summaries.length === 0 && (
          <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">
            {query === "" ? "No notes in this project" : "No matching titles"}
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

export function NotesSidebar({
  summaries,
  selectedId,
  range,
  onSelect,
  onDelete,
}: {
  summaries: NoteSummary[] | null;
  selectedId: string | null;
  range: DateRange;
  onSelect: (id: string) => void;
  onDelete: (summary: NoteSummary) => void;
}) {
  const today = todayKey();
  const days: string[] = [];
  for (let day = range.to; day >= range.from; day = addDays(day, -1)) {
    days.push(day);
  }

  const byDay = new Map<string, NoteSummary[]>();
  for (const summary of summaries ?? []) {
    const list = byDay.get(summary.date);
    if (list) {
      list.push(summary);
    } else {
      byDay.set(summary.date, [summary]);
    }
  }

  const isEmpty = summaries !== null && summaries.length === 0;

  return (
    <div className="flex-1 overflow-y-auto px-2 py-3">
      {days.map((day) => {
        const notes = byDay.get(day) ?? [];
        if (notes.length === 0 && day !== today) return null;
        return (
          <section key={day} className="mb-3">
            <DayHeading day={day} />
            {notes.length === 0 ? (
              <p className="px-2.5 py-1 text-[0.75rem] text-[var(--ink-faint)]">
                Press{" "}
                <kbd className="rounded border border-[var(--ink-border)] px-1 font-mono text-[0.65rem]">
                  ⌥N
                </kbd>{" "}
                to start writing
              </p>
            ) : (
              notes.map((summary) => (
                <NoteItem
                  key={summary.id}
                  summary={summary}
                  selected={summary.id === selectedId}
                  onSelect={() => onSelect(summary.id)}
                  onDelete={() => onDelete(summary)}
                />
              ))
            )}
          </section>
        );
      })}
      {isEmpty && !days.includes(today) && (
        <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">No notes this week</p>
      )}
    </div>
  );
}
