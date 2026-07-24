import { CalendarHeader } from "./calendar-chrome";
import type { DateRange, Month } from "./dates";
import { monthGrid, sameRange, weekOf } from "./dates";

/** 件数をインクの溜まりで表す。tier が上がるほど濃く・わずかに大きい */
function InkBlot({ count }: { count: number }) {
  if (count === 0) return null;
  const tier = count >= 4 ? 3 : count >= 2 ? 2 : 1;
  const size = [0, 16, 20, 24][tier];
  const opacity = [0, 0.14, 0.26, 0.4][tier];
  return (
    <span
      aria-hidden
      className="absolute rounded-full"
      style={{ width: size, height: size, background: "var(--ink)", opacity }}
    />
  );
}

export function NotesCalendar({
  month,
  counts,
  range,
  today,
  onMonthChange,
  onSelectWeek,
  onToday,
}: {
  month: Month;
  counts: Map<string, number>;
  range: DateRange;
  today: string;
  onMonthChange: (delta: number) => void;
  onSelectWeek: (dayKey: string) => void;
  onToday: () => void;
}) {
  const weeks = monthGrid(month);

  return (
    <div className="shrink-0 border-t border-[var(--ink-border)] px-2.5 pb-2.5 pt-2">
      <CalendarHeader
        month={month}
        titleTooltip="Back to the last 7 days"
        onTitleClick={onToday}
        onMonthChange={onMonthChange}
      />

      {weeks.map((week) => {
        const anchor = week.find((d) => d !== null) ?? null;
        const selected = anchor !== null && sameRange(weekOf(anchor), range);
        return (
          <button
            type="button"
            key={anchor ?? "empty"}
            onClick={() => anchor && onSelectWeek(anchor)}
            className={`relative grid w-full grid-cols-7 rounded-md px-0.5 transition-colors duration-100 hover:bg-[var(--ink-hover)] ${
              selected ? "bg-[var(--ink-hover)]" : ""
            }`}
          >
            {selected && (
              <span className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-[var(--ink-muted)]" />
            )}
            {week.map((day, i) =>
              day === null ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: 月外の空セル
                <span key={`empty-${i}`} className="h-7" />
              ) : (
                <span
                  key={day}
                  title={`${counts.get(day) ?? 0} notes`}
                  className="relative flex h-7 items-center justify-center"
                >
                  <InkBlot count={counts.get(day) ?? 0} />
                  {day === today && (
                    <span
                      aria-hidden
                      className="absolute inset-0 m-auto size-6 rounded-full ring-1 ring-[var(--ink-faint)]"
                    />
                  )}
                  <span
                    className={`relative font-mono text-[0.65rem] ${
                      day === today ? "text-[var(--ink-text)]" : "text-[var(--ink-muted)]"
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>
                </span>
              ),
            )}
          </button>
        );
      })}
    </div>
  );
}
