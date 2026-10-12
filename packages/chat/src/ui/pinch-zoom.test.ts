import { expect, test } from 'bun:test'

import { nextZoom } from './pinch-zoom.ts'

test('pinching out enlarges and pinching in shrinks', () => {
  expect(nextZoom(1, -10)).toBeGreaterThan(1)
  expect(nextZoom(1, 10)).toBeLessThan(1)
})

test('zoom stays between 0.8 and 2', () => {
  expect(nextZoom(1, -1000)).toBe(2)
  expect(nextZoom(1, 1000)).toBe(0.8)
})
