import { expect, test } from 'bun:test'

import { shrunkSize } from './screenshot.ts'

test('a screenshot taken at a device pixel ratio of 2 shrinks to half its pixels, the CSS pixels of the Browser Tab', () => {
  expect(shrunkSize({ width: 1724, height: 1526 }, 2)).toEqual({ width: 862, height: 763 })
})

test('a screenshot taken at a device pixel ratio of 1 keeps its size', () => {
  expect(shrunkSize({ width: 862, height: 763 }, 1)).toEqual({ width: 862, height: 763 })
})

test('a fractional device pixel ratio rounds to whole pixels', () => {
  expect(shrunkSize({ width: 1293, height: 1145 }, 1.5)).toEqual({ width: 862, height: 763 })
})

// side panel だけを縮めて表示しているときも、撮った画像より大きくしない。
test('a device pixel ratio below 1 does not enlarge the screenshot', () => {
  expect(shrunkSize({ width: 862, height: 763 }, 0.5)).toEqual({ width: 862, height: 763 })
})
