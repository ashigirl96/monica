import { afterEach, beforeEach, expect, test } from 'bun:test'

import { STALE_MS } from '../activity.ts'
import { activityTime, groupByRecency } from './recency.ts'

let tz: string | undefined
beforeEach(() => {
  tz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
})
afterEach(() => {
  process.env.TZ = tz ?? 'UTC'
})

// 2026-11-11 09:30 in Tokyo.
const now = new Date('2026-11-11T00:30:00Z')
const DAY = 24 * 60 * 60 * 1000

const at = (iso: string) => ({ lastActivityAt: new Date(iso) })
const ago = (ms: number) => ({ lastActivityAt: new Date(now.getTime() - ms) })

test('the sections split at the local midnight of today, 7 days and STALE_MS, in the order they came, without empty ones', () => {
  const justAfterMidnight = at('2026-11-10T15:00:00Z')
  const justBeforeMidnight = at('2026-11-10T14:59:59Z')
  const withinWeek = ago(7 * DAY - 1)
  const sevenDays = ago(7 * DAY)
  const beforeStale = ago(STALE_MS - 1)
  const stale = ago(STALE_MS)

  expect(
    groupByRecency(
      [justAfterMidnight, justBeforeMidnight, withinWeek, sevenDays, beforeStale, stale],
      now,
    ),
  ).toEqual([
    { section: 'today', label: '今日', items: [justAfterMidnight] },
    { section: 'week', label: 'この 1 週間', items: [justBeforeMidnight, withinWeek] },
    { section: 'earlier', label: 'それより前', items: [sevenDays, beforeStale] },
    { section: 'stale', label: 'しばらく触っていない', items: [stale] },
  ])
  expect(groupByRecency([stale], now)).toEqual([
    { section: 'stale', label: 'しばらく触っていない', items: [stale] },
  ])
})

test('STALE_MS is 90 days', () => {
  expect(STALE_MS).toBe(90 * DAY)
})

test('the time of the last activity is HH:MM today, N days ago within a week, and the local date before', () => {
  expect(activityTime(new Date('2026-11-10T15:05:00Z'), now)).toBe('00:05')
  expect(activityTime(new Date('2026-11-10T14:59:00Z'), now)).toBe('1 日前')
  expect(activityTime(new Date(now.getTime() - 7 * DAY + 1), now)).toBe('7 日前')
  expect(activityTime(new Date(now.getTime() - 7 * DAY), now)).toBe('2026-11-04')
  expect(activityTime(new Date('2026-01-01T15:00:00Z'), now)).toBe('2026-01-02')
})
