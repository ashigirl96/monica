import { expect, test } from 'bun:test'

import { pan, pinch } from './pinch-zoom.ts'

const W = 400
const H = 800
const unzoomed = { scale: 1, x: 0, y: 0 }

test('pinching out keeps the point under the fingers in place', () => {
  const view = pinch(unzoomed, -50, 100, 200, W, H)
  expect(view.scale).toBeGreaterThan(1)
  expect(view.x + 100 * view.scale).toBeCloseTo(100)
  expect(view.y + 200 * view.scale).toBeCloseTo(200)
})

test('scale stays between 1 and 5, and returning to 1 shows the whole panel', () => {
  expect(pinch(unzoomed, -10_000, 0, 0, W, H).scale).toBe(5)
  expect(pinch({ scale: 3, x: -500, y: -900 }, 10_000, 300, 300, W, H)).toEqual(unzoomed)
})

test('panning stops at the edges of the magnified panel', () => {
  const zoomed = { scale: 2, x: -200, y: -400 }
  expect(pan(zoomed, 10_000, 10_000, W, H)).toEqual({ scale: 2, x: -W, y: -H })
  expect(pan(zoomed, -10_000, -10_000, W, H)).toEqual({ scale: 2, x: 0, y: 0 })
})
