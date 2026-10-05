import { expect, test } from 'bun:test'

import { table } from './table.ts'

test('no rows make an empty string', () => {
  expect(table([])).toBe('')
})

test('cells missing from a row shorter than the header take no width', () => {
  expect(table([['a', 'b', 'c'], ['x']])).toBe('a  b  c\nx')
})

test('cells past the header are written unpadded', () => {
  expect(table([['a'], ['bb', 'c']])).toBe('a\nbb  c')
})
