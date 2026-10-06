function fromKey(key: string): Date {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
}

function toKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function weekday(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
}

export function dayLabel(key: string): string {
  const d = fromKey(key)
  return `${weekday(d)} ${d.getMonth() + 1}.${d.getDate()}`
}

/** 一覧は年をまたぐので、今年以外の日は年も見せる */
export function dayLabelWithYear(key: string): string {
  const d = fromKey(key)
  if (d.getFullYear() === new Date().getFullYear()) return dayLabel(key)
  return `${weekday(d)} ${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
}

export type Month = { year: number; month: number }

/** date key の属する月。logical today がブラウザの月と食い違うときはこちらが正 */
export function monthOf(key: string): Month {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }
}

export function sameMonth(a: Month, b: Month): boolean {
  return a.year === b.year && a.month === b.month
}

export function addMonths({ year, month }: Month, delta: number): Month {
  const d = new Date(year, month - 1 + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

export function monthLabel({ year, month }: Month): string {
  const name = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short' })
  return `${name.toUpperCase()} ${year}`
}

/** 日曜始まりの週ごとの date key。月外セルは null */
export function monthGrid({ year, month }: Month): (string | null)[][] {
  const first = new Date(year, month - 1, 1)
  const daysInMonth = new Date(year, month, 0).getDate()
  const weeks: (string | null)[][] = []
  let week: (string | null)[] = Array.from({ length: first.getDay() }, () => null)
  for (let day = 1; day <= daysInMonth; day++) {
    week.push(toKey(new Date(year, month - 1, day)))
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
  if (week.length > 0) {
    weeks.push([...week, ...Array.from({ length: 7 - week.length }, () => null)])
  }
  return weeks
}
