import { STALE_MS } from '../activity.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export type RecencySection = 'today' | 'week' | 'earlier' | 'stale'

const SECTIONS: { section: RecencySection; label: string }[] = [
  { section: 'today', label: '今日' },
  { section: 'week', label: 'この 1 週間' },
  { section: 'earlier', label: 'それより前' },
  { section: 'stale', label: 'しばらく触っていない' },
]

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

function sectionOf(at: Date, now: Date): RecencySection {
  const age = now.getTime() - at.getTime()
  if (localDate(at) === localDate(now)) return 'today'
  if (age < WEEK_MS) return 'week'
  if (age >= STALE_MS) return 'stale'
  return 'earlier'
}

export function groupByRecency<T extends { lastActivityAt: Date }>(
  items: readonly T[],
  now: Date,
): { section: RecencySection; label: string; items: T[] }[] {
  return SECTIONS.map(({ section, label }) => ({
    section,
    label,
    items: items.filter((item) => sectionOf(item.lastActivityAt, now) === section),
  })).filter((group) => group.items.length > 0)
}

export function activityTime(at: Date, now: Date): string {
  const section = sectionOf(at, now)
  if (section === 'today') return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (section === 'week') return `${Math.round((midnight(now) - midnight(at)) / DAY_MS)} 日前`
  return localDate(at)
}
