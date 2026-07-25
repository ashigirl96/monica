import { dayLabel, dayLabelWithYear } from "@/notes/dates";

/** 「daily が存在する日 + 今日」の降順リスト。1 日 = 1 行なので note 単位の UI は持たない */
export function DailySidebar({
  dates,
  selectedDate,
  today,
  onSelect,
}: {
  dates: string[] | null;
  selectedDate: string | null;
  today: string;
  onSelect: (date: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-2 py-3">
      {(dates ?? []).map((day) => {
        const selected = day === selectedDate;
        return (
          <div
            key={day}
            className={`group relative flex items-center rounded-md transition-colors duration-100 ${
              selected ? "bg-[var(--ink-hover)]" : "hover:bg-[var(--ink-hover)]"
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
                className={`font-mono text-[0.7rem] uppercase tracking-widest ${
                  selected ? "text-[var(--ink-text)]" : "text-[var(--ink-muted)]"
                }`}
              >
                {day === today ? `TODAY · ${dayLabel(day)}` : dayLabelWithYear(day)}
              </span>
            </button>
          </div>
        );
      })}
      {dates !== null && dates.length === 0 && (
        <p className="px-2.5 py-2 text-[0.75rem] text-[var(--ink-faint)]">No daily notes yet</p>
      )}
    </div>
  );
}
