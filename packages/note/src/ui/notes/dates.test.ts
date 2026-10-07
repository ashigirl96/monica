import { afterEach, expect, setSystemTime, test } from 'bun:test'

import { addMonths, dayLabel, dayLabelWithYear, monthGrid, monthLabel, slashDate } from './dates.ts'

afterEach(() => {
  setSystemTime()
})

test('a day is named by its weekday, month and day, and by its year too outside this year', () => {
  setSystemTime(new Date(2026, 9, 6, 12))

  expect(dayLabel('2026-10-06')).toBe('TUE 10.6')
  expect(dayLabelWithYear('2026-10-06')).toBe('TUE 10.6')
  expect(dayLabelWithYear('2025-10-06')).toBe('MON 2025.10.6')
  expect(dayLabelWithYear('2027-01-03')).toBe('SUN 2027.1.3')
})

test('the card of an Essay writes its date with slashes and no zero padding', () => {
  expect(slashDate('2026-07-01')).toBe('2026/7/1')
  expect(slashDate('2026-10-21')).toBe('2026/10/21')
})

test('a month is named in capitals with its year, and moves across years', () => {
  expect(monthLabel({ year: 2026, month: 9 })).toBe('SEP 2026')
  expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
  expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
})

test('the calendar of a month starts its weeks on Sunday and pads the days outside it', () => {
  const weeks = monthGrid({ year: 2026, month: 10 })

  expect(weeks[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03'])
  expect(weeks.at(-1)).toEqual([
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2026-10-31',
  ])
  expect(weeks).toHaveLength(5)
})
