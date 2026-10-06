import { expect, test } from 'bun:test'

import { cycleSelect } from './editor-support.ts'

const days = ['2026-10-07', '2026-10-06', '2026-10-01']

test('cycling moves one row and wraps around at either end', () => {
  expect(cycleSelect(days, '2026-10-06', 1)).toBe('2026-10-01')
  expect(cycleSelect(days, '2026-10-01', 1)).toBe('2026-10-07')
  expect(cycleSelect(days, '2026-10-07', -1)).toBe('2026-10-01')
})

test('from a row outside the list, cycling forward opens the first row and back the last', () => {
  expect(cycleSelect(days, '2026-09-01', 1)).toBe('2026-10-07')
  expect(cycleSelect(days, null, -1)).toBe('2026-10-01')
  expect(cycleSelect([], null, 1)).toBeUndefined()
})
