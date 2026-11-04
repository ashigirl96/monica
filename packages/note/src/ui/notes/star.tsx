import { useMemo } from 'react'

import { useNoteClient } from '../client.ts'
import { createStarToggle } from './star-toggle.ts'

/** 並びは Backend だけが決めるので、手元では並べ替えずに一覧を取り直す。 */
export function useToggleStar(invalidate: () => void) {
  const client = useNoteClient()
  return useMemo(
    () =>
      createStarToggle({
        read: (id) => client.get({ id }).then((note) => 'starred' in note && note.starred),
        send: (id, starred) => client.star({ id, starred }),
        invalidate,
      }),
    [client, invalidate],
  )
}

export function StarButton({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={starred ? 'Unstar note' : 'Star note'}
      aria-pressed={starred}
      title={starred ? 'Unstar (⌥S)' : 'Star (⌥S)'}
      onClick={onToggle}
      className={`shrink-0 rounded p-1 transition-opacity duration-100 hover:text-[var(--ink-text)] focus-visible:opacity-100 ${
        starred
          ? 'text-[var(--ink-muted)]'
          : 'text-[var(--ink-faint)] opacity-0 group-hover:opacity-100'
      }`}
    >
      <svg
        aria-hidden
        className="size-3"
        viewBox="0 0 24 24"
        fill={starred ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinejoin="round"
          d="m12 3.5 2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9L12 3.5z"
        />
      </svg>
    </button>
  )
}

export function startsUnstarred(list: readonly { starred: boolean }[], index: number): boolean {
  return list[index - 1]?.starred === true && list[index]?.starred === false
}

export function StarDivider() {
  return <div className="mx-2.5 my-1.5 border-t border-[var(--ink-border)]" />
}
