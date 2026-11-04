import { useCallback } from 'react'

import { useNoteClient } from '../client.ts'

/** 並びは Backend だけが決めるので、手元では並べ替えずに一覧を取り直す。
 * 一覧に無い Note は Star が無いとみなす（Star の付いた Note は一覧の先頭に揃う）。 */
export function useToggleStar(
  list: readonly { id: string; starred: boolean }[] | null,
  invalidate: () => void,
) {
  const client = useNoteClient()
  return useCallback(
    (id: string) => {
      const wasStarred = list?.find((s) => s.id === id)?.starred ?? false
      // 失敗しても、取り直した一覧が今の Star を出す。
      void client
        .star({ id, starred: !wasStarred })
        .catch(() => {})
        .finally(invalidate)
    },
    [client, list, invalidate],
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
