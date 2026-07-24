export type DateRange = { from: string; to: string };

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayKey(): string {
  return toKey(new Date());
}

export function addDays(key: string, days: number): string {
  const d = fromKey(key);
  d.setDate(d.getDate() + days);
  return toKey(d);
}

/** today を末尾とする直近7日。デフォルトのサイドバー表示範囲 */
export function rollingWeek(today: string): DateRange {
  return { from: addDays(today, -6), to: today };
}

/** key を含む日曜始まりの暦週。カレンダークリック時の表示範囲 */
export function weekOf(key: string): DateRange {
  const from = addDays(key, -fromKey(key).getDay());
  return { from, to: addDays(from, 6) };
}

export function sameRange(a: DateRange, b: DateRange): boolean {
  return a.from === b.from && a.to === b.to;
}

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function dayLabel(key: string): string {
  const d = fromKey(key);
  return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}.${d.getDate()}`;
}

/** project filter の一覧は年をまたぐので、今年以外の日は年も見せる */
export function dayLabelWithYear(key: string): string {
  const d = fromKey(key);
  if (d.getFullYear() === new Date().getFullYear()) return dayLabel(key);
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type Month = { year: number; month: number };

export function currentMonth(): Month {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** date key の属する月。logical today がブラウザの月と食い違うときはこちらが正 */
export function monthOf(key: string): Month {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

export function sameMonth(a: Month, b: Month): boolean {
  return a.year === b.year && a.month === b.month;
}

export function addMonths({ year, month }: Month, delta: number): Month {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function monthLabel({ year, month }: Month): string {
  const NAMES = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  return `${NAMES[month - 1]} ${year}`;
}

export function monthRange({ year, month }: Month): DateRange {
  return {
    from: toKey(new Date(year, month - 1, 1)),
    to: toKey(new Date(year, month, 0)),
  };
}

/** 日曜始まりの週ごとの date key。月外セルは null */
export function monthGrid({ year, month }: Month): (string | null)[][] {
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const weeks: (string | null)[][] = [];
  let week: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= daysInMonth; day++) {
    week.push(toKey(new Date(year, month - 1, day)));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    weeks.push([...week, ...Array.from({ length: 7 - week.length }, () => null)]);
  }
  return weeks;
}
