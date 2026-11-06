import { dayLabel, dayLabelWithYear } from '../../notes/dates.ts'

/**
 * 最上段に Pad を固定し、その下に「daily が存在する日 + 今日」の降順リストを出す。
 * 1 日 = 1 行なので note 単位の UI は持たない。
 */
export function DailySidebar({
  dates,
  selectedDate,
  today,
  padSelected,
  onSelectPad,
  onSelect,
}: {
  dates: string[] | null
  selectedDate: string | null
  today: string
  padSelected: boolean
  onSelectPad: () => void
  onSelect: (date: string) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pt-3 pb-2">
        <button
          type="button"
          onClick={onSelectPad}
          className={`relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 ${
            padSelected ? 'bg-[var(--ink-hover)]' : 'hover:bg-[var(--ink-hover)]'
          }`}
        >
          {padSelected && (
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
            <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
            <path strokeLinecap="round" d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
          </svg>
          <span
            className={`min-w-0 flex-1 truncate font-mono text-[0.78rem] ${
              padSelected ? 'text-[var(--ink-text)]' : 'text-[var(--ink-muted)]'
            }`}
          >
            Pad
          </span>
        </button>
      </div>
      <div className="mx-4.5 border-t border-[var(--ink-border)]" />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {(dates ?? []).map((day) => {
          const selected = day === selectedDate
          return (
            <div
              key={day}
              className={`group relative flex items-center rounded-md transition-colors duration-100 ${
                selected ? 'bg-[var(--ink-hover)]' : 'hover:bg-[var(--ink-hover)]'
              }`}
            >
              {selected && (
                <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-[var(--water)]" />
              )}
              <button
                type="button"
                onClick={() => onSelect(day)}
                className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
              >
                <span
                  className={`font-mono text-[0.7rem] tracking-widest uppercase ${
                    selected ? 'text-[var(--ink-text)]' : 'text-[var(--ink-muted)]'
                  }`}
                >
                  {day === today ? `TODAY · ${dayLabel(day)}` : dayLabelWithYear(day)}
                </span>
              </button>
            </div>
          )
        })}
        {dates !== null && dates.length === 0 && (
          <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">No daily notes yet</p>
        )}
      </div>
    </div>
  )
}
