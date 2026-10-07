import { useEffect, useRef } from 'react'

import type { RepoNoteSummary } from '../../../contract.ts'
import { summaryTitle } from '../../notes/summary.ts'

function TimelineItem({
  summary,
  selected,
  onSelect,
  onDelete,
}: {
  summary: RepoNoteSummary
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={`group relative flex items-center rounded-md transition-colors duration-100 ${
        selected ? 'bg-[var(--ink-hover)]' : 'hover:bg-[var(--ink-hover)]'
      }`}
    >
      {selected && (
        <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--water)]" />
      )}
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-2.5 py-1.5 text-left">
        <span
          className={`block truncate text-[0.8rem] ${
            selected ? 'text-[var(--ink-text)]' : 'text-[var(--ink-muted)]'
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
  )
}

/**
 * Repo のサイドバー。最上段に Scratch を固定し（`owner/repo` で名指す）、その下に
 * 時系列で Repo Note を出す。Scratch は削除できないので削除ボタンを出さない。
 */
export function RepoSidebar({
  repoName,
  scratchSelected,
  notes,
  selectedId,
  hasMore,
  onLoadMore,
  onSelectScratch,
  onSelect,
  onDelete,
}: {
  repoName: string
  scratchSelected: boolean
  notes: RepoNoteSummary[] | null
  selectedId: string | null
  hasMore: boolean
  onLoadMore: () => void
  onSelectScratch: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore])

  return (
    <div className="flex h-full flex-col">
      <div className="px-4.5 pt-4 pb-1">
        <span className="font-mono text-[0.7rem] tracking-widest text-[var(--ink-muted)] uppercase">
          Repo
        </span>
      </div>
      <div className="px-2 pt-1 pb-2">
        <button
          type="button"
          onClick={onSelectScratch}
          className={`relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 ${
            scratchSelected ? 'bg-[var(--ink-hover)]' : 'hover:bg-[var(--ink-hover)]'
          }`}
        >
          {scratchSelected && (
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
              scratchSelected ? 'text-[var(--ink-text)]' : 'text-[var(--ink-muted)]'
            }`}
          >
            {repoName}
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
            onDelete={() => onDelete(s.id)}
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
  )
}
