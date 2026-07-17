import type { DateRange, Month } from "./dates";
import { monthGrid, monthLabel, sameRange, todayKey, weekOf } from "./dates";

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

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded text-[var(--ink-faint)] transition-colors duration-100 hover:bg-[var(--ink-hover)] hover:text-[var(--ink-muted)]"
    >
      {children}
    </button>
  );
}

export function NotesCalendar({
  month,
  counts,
  range,
  onMonthChange,
  onSelectWeek,
  onToday,
}: {
  month: Month;
  counts: Map<string, number>;
  range: DateRange;
  onMonthChange: (delta: number) => void;
  onSelectWeek: (dayKey: string) => void;
  onToday: () => void;
}) {
  const today = todayKey();
  const weeks = monthGrid(month);

  return (
    <div className="shrink-0 border-t border-[var(--ink-border)] px-2.5 pb-2.5 pt-2">
      <div className="flex items-center justify-between px-1.5 pb-1.5">
        <button
          type="button"
          onClick={onToday}
          title="Back to the last 7 days"
          className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--ink-muted)] transition-colors duration-100 hover:text-[var(--ink-text)]"
        >
          {monthLabel(month)}
        </button>
        <div className="flex gap-0.5">
          <NavButton label="Previous month" onClick={() => onMonthChange(-1)}>
            <svg
              className="size-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </NavButton>
          <NavButton label="Next month" onClick={() => onMonthChange(1)}>
            <svg
              className="size-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </NavButton>
        </div>
      </div>

      <div className="grid grid-cols-7 px-0.5 pb-0.5">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定 7 要素の曜日ヘッダ
          <span key={i} className="text-center font-mono text-[0.6rem] text-[var(--ink-faint)]">
            {d}
          </span>
        ))}
      </div>

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
