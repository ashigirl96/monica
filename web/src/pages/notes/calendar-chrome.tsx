import type { Month } from "./dates";
import { monthLabel } from "./dates";

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

/** 月ラベル + 前後ナビ + 曜日ヘッダ。notes / daily 両カレンダーで共有する枠 */
export function CalendarHeader({
  month,
  titleTooltip,
  onTitleClick,
  onMonthChange,
}: {
  month: Month;
  titleTooltip: string;
  onTitleClick: () => void;
  onMonthChange: (delta: number) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-1.5 pb-1.5">
        <button
          type="button"
          onClick={onTitleClick}
          title={titleTooltip}
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
    </>
  );
}
