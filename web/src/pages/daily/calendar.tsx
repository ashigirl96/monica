import { CalendarHeader } from "../notes/calendar-chrome";
import type { Month } from "../notes/dates";
import { monthGrid } from "../notes/dates";

/**
 * /daily のカレンダー。notes と違い週選択は持たず、日セルそのものがボタン —
 * 空日タップはその日の daily をその場で作成して開く入口になる。
 */
export function DailyCalendar({
  month,
  existing,
  selectedDate,
  today,
  onMonthChange,
  onSelectDay,
  onToday,
}: {
  month: Month;
  existing: Set<string>;
  selectedDate: string | null;
  today: string;
  onMonthChange: (delta: number) => void;
  onSelectDay: (dayKey: string) => void;
  onToday: () => void;
}) {
  const weeks = monthGrid(month);

  return (
    <div className="shrink-0 border-t border-[var(--ink-border)] px-2.5 pb-2.5 pt-2">
      <CalendarHeader
        month={month}
        titleTooltip="Back to today"
        onTitleClick={onToday}
        onMonthChange={onMonthChange}
      />

      {weeks.map((week) => (
        <div key={week.find((d) => d !== null) ?? "empty"} className="grid grid-cols-7 px-0.5">
          {week.map((day, i) =>
            day === null ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: 月外の空セル
              <span key={`empty-${i}`} className="h-7" />
            ) : (
              <button
                type="button"
                key={day}
                title={existing.has(day) ? `Open ${day}` : `Start ${day}`}
                onClick={() => onSelectDay(day)}
                className="relative flex h-7 items-center justify-center rounded transition-colors duration-100 hover:bg-[var(--ink-hover)]"
              >
                {day === selectedDate && (
                  <span
                    aria-hidden
                    className="absolute inset-0 m-auto size-6 rounded-full bg-[var(--ink-hover)]"
                  />
                )}
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
                {existing.has(day) && (
                  <span
                    aria-hidden
                    className="absolute bottom-0.5 size-1 rounded-full bg-[var(--ink-muted)]"
                  />
                )}
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
